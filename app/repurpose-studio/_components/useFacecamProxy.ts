// ===========================================================================
// useFacecamProxy -- low-res preview proxy for the (huge) facecam raw
// ===========================================================================
// The preview <video> plays the raw facecam, which is often multi-GB. Every
// hard seek into it (scrubbing, cold cuts, the double-buffer fallback) pays
// for range-fetching + decoding a big long-GOP file. This hook swaps the
// PREVIEW's face source for a one-time low-res dense-keyframe proxy built by
// ffmpeg on the server (/api/repurpose/proxy) -- seeks drop to tens of ms and
// decode gets far lighter. EXPORT IS UNTOUCHED: footageMeta.faceCamPath still
// points at the original file; only the src handed to the preview's face
// <video> elements changes, so the rendered reel keeps full quality.
//
// Lifecycle: on footage load, ask the server for proxy status; kick off a
// build if none exists (idempotent), poll while building, and once ready
// swap the preview src -- but ONLY while playback is paused, so the running
// video is never yanked mid-play. The proxy is keyed server-side by the raw
// file's path+mtime+size, so edits to the PROJECT never invalidate it; only
// replacing the raw footage does.
// ===========================================================================

import { useCallback, useEffect, useRef, useState } from "react";

type ProxyStatus = "ready" | "building" | "none" | "unavailable";

interface ProxyApiState {
  status: ProxyStatus;
  outTimeSec?: number;
}

export interface FacecamProxyState {
  /** The src the preview's face <video> slots should use RIGHT NOW. */
  src: string | undefined;
  /** True while the preview is actually playing from the low-res proxy. */
  usingProxy: boolean;
  /** 0..1 build progress while the proxy is generating, else null. */
  buildProgress: number | null;
  /**
   * Wire to the face <video>s' onError. If the proxy src ever fails to load
   * (temp-dir cache purged between sessions), fall straight back to the
   * original file and re-request a rebuild -- playback must never be worse
   * than the pre-proxy behavior.
   */
  onSrcError: () => void;
}

/** Poll cadence while the server is running the one-time ffmpeg pass. */
const POLL_MS = 2500;

/**
 * Extract the raw absolute OS path from whatever reference the store holds.
 * footageMeta.faceCamPath is normally the streaming URL
 * (`/api/repurpose/video?path=...`) produced by footageUrlForPath; a raw
 * `/Users/...` path is accepted too. blob:/http(s): sources (file-picker
 * drops) have no server-readable path, so no proxy is possible -> null.
 */
function rawPathFromRef(ref: string | undefined): string | null {
  if (!ref) return null;
  if (ref.startsWith("/api/repurpose/video?")) {
    try {
      const url = new URL(ref, "http://localhost");
      return url.searchParams.get("path");
    } catch {
      return null;
    }
  }
  if (ref.startsWith("/Users/") || ref.startsWith("/home/") || ref.startsWith("/Volumes/")) {
    return ref;
  }
  return null;
}

/** The streaming URL that serves the low-res proxy of `rawPath`. */
function proxyUrlFor(rawPath: string): string {
  return `/api/repurpose/video?path=${encodeURIComponent(rawPath)}&quality=proxy`;
}

export function useFacecamProxy(
  faceCamPath: string | undefined,
  durationSec: number | undefined,
  isPlaying: boolean
): FacecamProxyState {
  const rawPath = rawPathFromRef(faceCamPath);

  // "ready" is server truth; "active" is whether the preview has SWAPPED to
  // the proxy src (deferred while playing). Separate so a proxy that becomes
  // ready mid-playback waits for the next pause instead of yanking the video.
  const [serverReady, setServerReady] = useState(false);
  const [active, setActive] = useState(false);
  const [outTimeSec, setOutTimeSec] = useState<number | null>(null);
  const [building, setBuilding] = useState(false);
  // A proxy URL that 404'd (purged cache) is quarantined for this session so
  // we never flip-flop: fall back to the original + rebuild, and only a fresh
  // mount / footage change tries the proxy again.
  const [failed, setFailed] = useState(false);

  // --- Status check + build kickoff + poll-while-building --------------------
  useEffect(() => {
    setServerReady(false);
    setActive(false);
    setOutTimeSec(null);
    setBuilding(false);
    setFailed(false);
    if (!rawPath) return;

    const aborter = new AbortController();
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const readState = async (init?: RequestInit): Promise<ProxyApiState | null> => {
      try {
        const res = await fetch(
          `/api/repurpose/proxy?path=${encodeURIComponent(rawPath)}`,
          { ...init, signal: aborter.signal }
        );
        if (!res.ok) return null;
        return (await res.json()) as ProxyApiState;
      } catch {
        return null; // aborted or network hiccup -- treated as "no proxy"
      }
    };

    const handle = (state: ProxyApiState | null) => {
      if (disposed || !state) return;
      if (state.status === "ready") {
        setBuilding(false);
        setServerReady(true);
        return;
      }
      if (state.status === "building") {
        setBuilding(true);
        setOutTimeSec(state.outTimeSec ?? null);
        pollTimer = setTimeout(async () => handle(await readState()), POLL_MS);
        return;
      }
      if (state.status === "none") {
        // Kick the one-time build (idempotent server-side), then poll.
        void (async () => {
          const started = await readState({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: rawPath }),
          });
          handle(started);
        })();
        return;
      }
      // "unavailable" (no ffmpeg / unsupported container): stay on the original.
      setBuilding(false);
    };

    void (async () => handle(await readState()))();

    return () => {
      disposed = true;
      aborter.abort();
      if (pollTimer !== null) clearTimeout(pollTimer);
    };
  }, [rawPath]);

  // --- Deferred swap: apply the proxy only while paused -----------------------
  // Swapping <video>.src mid-playback drops the picture for however long the
  // new source takes to buffer. The proxy is a pure enhancement, so it waits
  // for a natural pause; scrubbing/next play then runs on the proxy.
  useEffect(() => {
    if (serverReady && !isPlaying && !failed && !active) setActive(true);
  }, [serverReady, isPlaying, failed, active]);

  const onSrcError = useCallback(() => {
    // Only react when the PROXY src is what failed -- an error from the
    // original file is not ours to handle here.
    setActive((wasActive) => {
      if (!wasActive) return wasActive;
      setFailed(true);
      setServerReady(false);
      // Rebuild in the background for next session; playback continues on the
      // original file immediately (src falls back below on this render).
      if (rawPath) {
        void fetch(`/api/repurpose/proxy?path=${encodeURIComponent(rawPath)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: rawPath }),
        }).catch(() => {});
      }
      return false;
    });
  }, [rawPath]);

  const buildProgress =
    building && outTimeSec !== null && durationSec && durationSec > 0
      ? Math.max(0, Math.min(1, outTimeSec / durationSec))
      : building
        ? 0
        : null;

  return {
    src: active && rawPath ? proxyUrlFor(rawPath) : faceCamPath || undefined,
    usingProxy: active,
    buildProgress,
    onSrcError,
  };
}
