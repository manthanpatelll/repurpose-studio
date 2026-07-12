// ===========================================================================
// REPURPOSE STUDIO -- face-cam waveform peaks (timeline navigation aid)
// ===========================================================================
// Decodes the face-cam audio ONCE into a downsampled peaks array spanning the
// WHOLE source file, so every clip block on the Face track can draw the slice
// of the waveform for its own [srcStart, srcEnd] source range -- a cheap,
// glanceable way to find pauses / beats without scrubbing.
//
// DESIGN
//   - ONE decode per face path, cached in a module-level Map keyed by the URL,
//     shared by all clip blocks (never per-clip, never on the render/export
//     path). A concurrent decode is de-duped via an in-flight promise map so a
//     re-render mid-decode doesn't kick off a second decode.
//   - Peaks are absolute-max magnitude per bin (a symmetric waveform), 0..1.
//     BIN_COUNT buckets across the full decoded duration; a clip samples the
//     sub-range covering its source seconds, so zooming in shows more detail.
//   - PRIMARY decode: fetch(url) -> AudioContext.decodeAudioData. The face path
//     is always an HTTP-fetchable URL here (blob:, a static path, or the
//     /api/repurpose/video range route), so this works for the common case.
//   - FALLBACK decode: mediabunny AudioBufferSink (the SAME decoder the export
//     pipeline uses, so we know the audio is decodable) when decodeAudioData
//     can't handle the container/codec. This never runs on the export path.
//   - GUARD: any failure (no path, no audio track, decode error) resolves to
//     null and the timeline silently renders NO waveform -- clips look exactly
//     as they did before. Nothing here can throw into React render.
// ===========================================================================

"use client";

import { useEffect, useState } from "react";
import type { FootageMeta } from "@/lib/repurpose/types";

/** Downsampled, whole-file waveform peaks for one face-cam source. */
export interface FaceWaveform {
  /** Absolute-max amplitude per bin, length === BIN_COUNT, each value 0..1. */
  peaks: Float32Array;
  /** Total decoded source duration in seconds (peaks span [0, duration]). */
  duration: number;
}

/**
 * How many buckets to summarize the WHOLE source into. At a few-minute source
 * that is roughly one bin per 30-80ms -- plenty of resolution for a clip that
 * only spans a slice of it, while staying tiny to hold in memory and cheap to
 * slice per clip. Higher than the reel-overlay hook's 1024 because here a
 * single clip may be a small fraction of the whole file.
 */
const BIN_COUNT = 4000;

/** Whole-file peaks per face path, computed once. null = decoded, no audio. */
const cache = new Map<string, FaceWaveform | null>();
/** In-flight decodes per face path, so a re-render mid-decode doesn't re-decode. */
const inflight = new Map<string, Promise<FaceWaveform | null>>();

/**
 * Reduce a mono channel (Float32) into BIN_COUNT absolute-max peaks in [0, 1].
 * Shared by both decode paths so they produce an identical peaks shape.
 */
function channelToPeaks(channel: Float32Array): Float32Array {
  const samplesPerBin = Math.max(1, Math.floor(channel.length / BIN_COUNT));
  const peaks = new Float32Array(BIN_COUNT);
  let globalMax = 0;
  for (let i = 0; i < BIN_COUNT; i++) {
    const start = i * samplesPerBin;
    const end = Math.min(channel.length, start + samplesPerBin);
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = channel[j] < 0 ? -channel[j] : channel[j];
      if (v > max) max = v;
    }
    peaks[i] = max;
    if (max > globalMax) globalMax = max;
  }
  // Normalize to the loudest peak so quiet takes still read at a glance. Guard
  // against a fully silent buffer (globalMax 0) -> leave zeros.
  if (globalMax > 0) {
    const inv = 1 / globalMax;
    for (let i = 0; i < BIN_COUNT; i++) peaks[i] *= inv;
  }
  return peaks;
}

/** PRIMARY: fetch the URL and decode via the Web Audio API. */
async function decodeViaWebAudio(url: string): Promise<FaceWaveform | null> {
  const Ctor =
    (typeof window !== "undefined" && (window.AudioContext as typeof AudioContext)) ||
    (typeof window !== "undefined" &&
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) ||
    null;
  if (!Ctor) return null;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();

  const ac = new Ctor();
  try {
    // decodeAudioData detaches the ArrayBuffer; slice(0) hands it a copy.
    const audioBuf = await ac.decodeAudioData(buf.slice(0));
    const channel = audioBuf.getChannelData(0);
    return { peaks: channelToPeaks(channel), duration: audioBuf.duration };
  } finally {
    ac.close().catch(() => {});
  }
}

/**
 * FALLBACK: decode via mediabunny's AudioBufferSink -- the SAME path the export
 * pipeline (lib/repurpose/export-short.ts) uses, so if that can produce audio
 * this can too. Streams the whole track, copying channel 0 of every decoded
 * buffer into one flat Float32Array, then downsamples to peaks.
 */
async function decodeViaMediabunny(url: string): Promise<FaceWaveform | null> {
  const { Input, UrlSource, ALL_FORMATS, AudioBufferSink } = await import("mediabunny");

  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
  try {
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) return null;
    if (!(await audioTrack.canDecode())) return null;

    const sampleRate = audioTrack.sampleRate;
    if (!sampleRate || sampleRate <= 0) return null;

    const sink = new AudioBufferSink(audioTrack);

    // Collect channel-0 slices, then flatten once. Keeping the slices avoids a
    // giant pre-allocation when the exact sample count is unknown up front.
    const chunks: Float32Array[] = [];
    let totalSamples = 0;
    for await (const { buffer } of sink.buffers()) {
      const data = buffer.getChannelData(0);
      // Copy: the sink may recycle the underlying buffer after we advance.
      const copy = new Float32Array(data.length);
      copy.set(data);
      chunks.push(copy);
      totalSamples += copy.length;
    }
    if (totalSamples === 0) return null;

    const flat = new Float32Array(totalSamples);
    let offset = 0;
    for (const c of chunks) {
      flat.set(c, offset);
      offset += c.length;
    }

    return { peaks: channelToPeaks(flat), duration: totalSamples / sampleRate };
  } finally {
    try {
      await (input as unknown as { dispose?: () => Promise<void> | void }).dispose?.();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Cheap reachability probe: is this URL actually fetchable RIGHT NOW? A restored
 * project brings back a `blob:` footage URL that died on reload (the object URL's
 * blob is gone), so every decode below would throw "Failed to fetch". Worse, the
 * mediabunny fallback's UrlSource RETRIES the fetch and logs each failure to the
 * console itself before rejecting -- noisy red errors for a known-dead URL that
 * the app already handles (the re-import banner). Probe once here and skip both
 * decoders when the source can't be reached, so a dead blob resolves quietly to
 * null (no waveform, no console spam) instead of throwing through two decoders.
 * Uses a 1-byte Range GET: HEAD isn't supported on `blob:` URLs, but a ranged GET
 * is, and it transfers almost nothing on a live /api/repurpose/video source.
 */
async function isUrlReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-0" } });
    // 200 (whole body) or 206 (partial) both mean the source is live.
    return res.ok || res.status === 206;
  } catch {
    return false;
  }
}

/**
 * Compute the whole-file peaks for one face path (primary Web Audio decode,
 * mediabunny fallback). Never rejects -- any failure resolves to null so the
 * caller renders no waveform. Result (including null) is cached per path.
 */
async function computeFaceWaveform(url: string): Promise<FaceWaveform | null> {
  // Bail before touching either decoder if the source is a dead blob / offline
  // path -- avoids the mediabunny UrlSource's own retry-and-log noise.
  if (!(await isUrlReachable(url))) return null;
  try {
    const viaWebAudio = await decodeViaWebAudio(url);
    if (viaWebAudio) return viaWebAudio;
  } catch {
    // fall through to the mediabunny path
  }
  try {
    return await decodeViaMediabunny(url);
  } catch {
    return null;
  }
}

/**
 * useAudioWaveform: whole-source peaks for ANY fetchable audio/video URL (or
 * null while decoding / when there is no decodable audio). Computed at most
 * ONCE per URL (module-level cache) and shared by every consumer. Decode is
 * async and off the render path, so it never blocks first paint -- blocks
 * render immediately and the waveform fades in when the peaks are ready.
 * Powers the face-cam clips AND the Music/SFX track blocks.
 */
export function useAudioWaveform(url: string | null): FaceWaveform | null {
  const [waveform, setWaveform] = useState<FaceWaveform | null>(() =>
    url ? cache.get(url) ?? null : null
  );

  useEffect(() => {
    if (!url) {
      setWaveform(null);
      return;
    }

    // Already computed (may be a cached null = "decoded, no audio").
    if (cache.has(url)) {
      setWaveform(cache.get(url) ?? null);
      return;
    }

    let cancelled = false;
    setWaveform(null);

    let promise = inflight.get(url);
    if (!promise) {
      promise = computeFaceWaveform(url).then((result) => {
        cache.set(url, result);
        inflight.delete(url);
        return result;
      });
      inflight.set(url, promise);
    }

    promise.then((result) => {
      if (!cancelled) setWaveform(result);
    });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return waveform;
}

/**
 * useFaceWaveform: the face-cam-specific wrapper -- same shared peaks cache,
 * keyed on footage's faceCamPath. Kept as its own named hook so clip-block call
 * sites read at the right altitude.
 */
export function useFaceWaveform(footageMeta: FootageMeta | null): FaceWaveform | null {
  return useAudioWaveform(footageMeta?.faceCamPath || null);
}

/**
 * Slice the whole-file peaks for one clip's SOURCE range into `outBins` sample
 * values (absolute-max amplitude per output bin, 0..1). Pure + cheap -- called
 * by a clip block only when its pixel width changes, never per frame. Returns
 * an empty array when the range is invalid or there are no peaks to sample.
 */
export function sliceClipPeaks(
  waveform: FaceWaveform | null,
  srcStart: number,
  srcEnd: number,
  outBins: number
): number[] {
  if (!waveform || outBins <= 0) return [];
  const { peaks, duration } = waveform;
  if (duration <= 0 || peaks.length === 0) return [];
  if (srcEnd <= srcStart) return [];

  const total = peaks.length;
  // Map the clip's source seconds to a bin sub-range of the whole-file peaks.
  const startBin = Math.max(0, Math.min(total - 1, (srcStart / duration) * total));
  const endBin = Math.max(0, Math.min(total, (srcEnd / duration) * total));
  const span = endBin - startBin;
  if (span <= 0) return [];

  const out = new Array<number>(outBins);
  const binsPerOut = span / outBins;
  for (let i = 0; i < outBins; i++) {
    const from = startBin + i * binsPerOut;
    const to = startBin + (i + 1) * binsPerOut;
    const fromIdx = Math.floor(from);
    const toIdx = Math.min(total, Math.max(fromIdx + 1, Math.ceil(to)));
    let max = 0;
    for (let j = fromIdx; j < toIdx; j++) {
      const v = peaks[j];
      if (v > max) max = v;
    }
    out[i] = max;
  }
  return out;
}
