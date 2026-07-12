"use client";

// ===========================================================================
// REPURPOSE STUDIO -- useSfxPreview
// ===========================================================================
// Makes the generated Sound-Effects track AUDIBLE during live preview.
//
// The SFX bed is a single full-length WAV placed in OUTPUT time (it starts at
// output t=0 and spans 0..duration). The face-cam <video> in PreviewCanvas is
// the master clock and plays its own (narration) audio independently; this hook
// plays the SFX through WebAudio and lets the two streams simply SUM at the
// speakers -- we never touch or mute the <video>.
//
// Design (deliberately simple + robust, not sample-accurate -- the EXPORT path
// mixes the SFX separately and precisely):
//   - One lazily-created, reused AudioContext (ref).
//   - When `src` changes: fetch -> arrayBuffer -> decodeAudioData into a buffer
//     ref. A monotonic token guards the async race so a stale decode (src
//     changed again mid-flight) is ignored. null track clears the buffer.
//   - Playback is RESTART-on-play, not continuous scheduling: on the PLAY
//     transition we resume the context, spin up a fresh BufferSource -> Gain,
//     set playbackRate, and `start(0, playheadSeconds)` so the bed begins at the
//     current output time. On PAUSE / stop / seek-while-playing / null / unmount
//     we stop + disconnect the active source; the next PLAY recreates it at the
//     then-current offset (so scrub-then-play resyncs).
//   - A big playhead jump (> ~0.3s) WHILE playing is treated as a seek and
//     restarts the source at the new offset.
//   - `gain` is applied live to the GainNode without restarting.
// ===========================================================================

import { useEffect, useRef } from "react";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { MusicTrack, SfxTrack } from "@/lib/repurpose/types";

/** A playhead delta larger than this (seconds) while playing counts as a seek. */
const SEEK_JUMP_SEC = 0.3;

type AudioCtxCtor = typeof AudioContext;

/**
 * Plays the store's `sfxTrack` through WebAudio in sync with preview playback so
 * the sound-effects bed is audible live, summing acoustically with the face-cam
 * <video> audio. Pass the current `sfxTrack` (from
 * `useRepurposeStore((s) => s.sfxTrack)`); passing `null` stops any playback.
 */
export function useSfxPreview(sfxTrack: SfxTrack | null): void {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  // The active graph while the bed is sounding (null when silent).
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  // Monotonic token so a stale async decode (src changed again mid-fetch) is
  // dropped instead of clobbering the current buffer.
  const decodeTokenRef = useRef(0);
  // Last playhead we (re)started the source at -- used to detect seek jumps.
  const lastPlayheadRef = useRef(0);

  const src = sfxTrack?.src ?? null;
  const gain = sfxTrack?.gain ?? 1;

  // --- Lazy AudioContext accessor (guarded for SSR / unsupported browsers) ----
  const getCtx = (): AudioContext | null => {
    if (audioCtxRef.current) return audioCtxRef.current;
    if (typeof window === "undefined") return null;
    const Ctor: AudioCtxCtor | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioCtxCtor })
        .webkitAudioContext;
    if (!Ctor) return null;
    audioCtxRef.current = new Ctor();
    return audioCtxRef.current;
  };

  // --- Stop + tear down the active source (safe to call when already silent) --
  const stopSource = () => {
    const source = sourceRef.current;
    const gainNode = gainNodeRef.current;
    if (source) {
      try {
        source.stop();
      } catch {
        // stop() throws if the node never started / already stopped -- ignore.
      }
      source.disconnect();
    }
    if (gainNode) gainNode.disconnect();
    sourceRef.current = null;
    gainNodeRef.current = null;
  };

  // --- (Re)start the bed at the current output playhead ----------------------
  const startAt = (offsetSec: number) => {
    const ctx = getCtx();
    const buffer = bufferRef.current;
    if (!ctx || !buffer) return;
    stopSource(); // never stack two sources
    void ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const rate = useRepurposeStore.getState().playbackRate;
    source.playbackRate.value = rate > 0 ? rate : 1;
    const gainNode = ctx.createGain();
    gainNode.gain.value = useRepurposeStore.getState().sfxTrack?.gain ?? 1;
    source.connect(gainNode).connect(ctx.destination);
    // Clamp the offset into the buffer; a playhead past the bed = nothing to play.
    const offset = Math.max(0, offsetSec);
    if (offset >= buffer.duration) {
      source.disconnect();
      gainNode.disconnect();
      return;
    }
    source.start(0, offset);
    sourceRef.current = source;
    gainNodeRef.current = gainNode;
    lastPlayheadRef.current = offsetSec;
  };

  // --- Decode the WAV whenever the source URL changes ------------------------
  useEffect(() => {
    const token = ++decodeTokenRef.current;
    // Any src change invalidates the currently-sounding bed.
    stopSource();
    if (!src) {
      bufferRef.current = null;
      return;
    }
    const ctx = getCtx();
    if (!ctx) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(src);
        const bytes = await res.arrayBuffer();
        const decoded = await ctx.decodeAudioData(bytes);
        // Drop if a newer src won the race (or this effect was cleaned up).
        if (cancelled || token !== decodeTokenRef.current) return;
        bufferRef.current = decoded;
        // If we're already playing when the decode lands, begin at the live head.
        const state = useRepurposeStore.getState();
        if (state.isPlaying) startAt(state.playhead);
      } catch {
        if (cancelled || token !== decodeTokenRef.current) return;
        bufferRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
    // getCtx / startAt / stopSource are stable refs-only closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // --- Drive start / stop / seek off the store (subscribe, no re-render) ------
  useEffect(() => {
    // Seed the play/head baseline from the current state.
    let prevPlaying = useRepurposeStore.getState().isPlaying;
    lastPlayheadRef.current = useRepurposeStore.getState().playhead;

    const unsub = useRepurposeStore.subscribe((state) => {
      const playing = state.isPlaying;
      const head = state.playhead;

      if (playing && !prevPlaying) {
        // PLAY transition -> (re)start at the current offset.
        startAt(head);
      } else if (!playing && prevPlaying) {
        // PAUSE / stop -> silence; next play recreates at the new offset.
        stopSource();
      } else if (playing) {
        // Still playing: a big playhead jump = a seek -> restart at new offset.
        if (Math.abs(head - lastPlayheadRef.current) > SEEK_JUMP_SEC) {
          startAt(head);
        } else {
          lastPlayheadRef.current = head;
        }
      }

      prevPlaying = playing;
    });

    // If we mounted mid-playback, get the bed sounding right away.
    if (prevPlaying) startAt(lastPlayheadRef.current);

    return () => {
      unsub();
      stopSource();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Live gain: update the GainNode without restarting ---------------------
  useEffect(() => {
    const gainNode = gainNodeRef.current;
    const ctx = audioCtxRef.current;
    if (!gainNode) return;
    if (ctx) {
      // setTargetAtTime avoids a click on abrupt gain changes.
      gainNode.gain.setTargetAtTime(gain, ctx.currentTime, 0.01);
    } else {
      gainNode.gain.value = gain;
    }
  }, [gain]);
}

// ===========================================================================
// useMusicPreview
// ===========================================================================
// The music twin of {@link useSfxPreview}. Plays the store's manual BACKGROUND-
// MUSIC bed through WebAudio so it's audible live, summing acoustically with the
// face-cam <video> AND the SFX bed at the speakers -- we never touch the <video>.
//
// The one difference from useSfxPreview is the START OFFSET: the music begins at
// OUTPUT time `startAtSec` (SFX begins at 0). So the music's internal read
// offset for a given output playhead P is `P - startAtSec`:
//   - P >= startAtSec: music is already sounding -> start(0, P - startAtSec).
//   - P <  startAtSec: the reel hasn't reached the music yet -> schedule the
//     source to begin after a real-time delay of (startAtSec - P) seconds via
//     start(ctx.currentTime + delay, 0), so it comes in on cue as playback runs.
//   - P - startAtSec >= srcDuration: the music has fully played out by P -> play
//     nothing.
// Everything else (restart-on-play, seek-jump restart, live gain, decode-race
// token) mirrors useSfxPreview exactly.
// ===========================================================================

/**
 * Plays the store's `musicTrack` through WebAudio in sync with preview playback
 * so the background-music bed is audible live, honoring its `startAtSec` output
 * offset. Pass the current `musicTrack` (from
 * `useRepurposeStore((s) => s.musicTrack)`); passing `null` stops any playback.
 */
export function useMusicPreview(musicTrack: MusicTrack | null): void {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  // The active graph while the bed is sounding (null when silent).
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  // Monotonic token so a stale async decode (src changed again mid-fetch) is
  // dropped instead of clobbering the current buffer.
  const decodeTokenRef = useRef(0);
  // Last playhead we (re)started the source at -- used to detect seek jumps.
  const lastPlayheadRef = useRef(0);

  const src = musicTrack?.src ?? null;
  const gain = musicTrack?.gain ?? 1;

  // --- Lazy AudioContext accessor (guarded for SSR / unsupported browsers) ----
  const getCtx = (): AudioContext | null => {
    if (audioCtxRef.current) return audioCtxRef.current;
    if (typeof window === "undefined") return null;
    const Ctor: AudioCtxCtor | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioCtxCtor })
        .webkitAudioContext;
    if (!Ctor) return null;
    audioCtxRef.current = new Ctor();
    return audioCtxRef.current;
  };

  // --- Stop + tear down the active source (safe to call when already silent) --
  const stopSource = () => {
    const source = sourceRef.current;
    const gainNode = gainNodeRef.current;
    if (source) {
      try {
        source.stop();
      } catch {
        // stop() throws if the node never started / already stopped -- ignore.
      }
      source.disconnect();
    }
    if (gainNode) gainNode.disconnect();
    sourceRef.current = null;
    gainNodeRef.current = null;
  };

  // --- (Re)start the bed for the current output playhead ----------------------
  // `head` is the OUTPUT-timeline playhead; the music starts at output time
  // `startAtSec`, so its internal read offset is `head - startAtSec`.
  const startAt = (head: number) => {
    const ctx = getCtx();
    const buffer = bufferRef.current;
    const track = useRepurposeStore.getState().musicTrack;
    if (!ctx || !buffer || !track) return;
    stopSource(); // never stack two sources
    void ctx.resume();

    const rate = useRepurposeStore.getState().playbackRate;
    const playbackRate = rate > 0 ? rate : 1;
    const startAtSec = track.startAtSec;
    // Where the playhead sits RELATIVE to the music's output start. Negative =
    // the reel hasn't reached the music yet.
    const relative = head - startAtSec;

    // The music has already fully played out by this playhead -- nothing to do.
    if (relative >= buffer.duration) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    const gainNode = ctx.createGain();
    gainNode.gain.value = track.gain ?? 1;
    source.connect(gainNode).connect(ctx.destination);

    if (relative >= 0) {
      // Music is already sounding at this playhead -> start immediately, offset in.
      source.start(0, relative);
    } else {
      // Playhead is BEFORE the music start -> schedule it to come in on cue after
      // a real-time delay. The delay shrinks with playbackRate so a sped-up
      // preview reaches the music proportionally sooner.
      const delay = -relative / playbackRate;
      source.start(ctx.currentTime + delay, 0);
    }
    sourceRef.current = source;
    gainNodeRef.current = gainNode;
    lastPlayheadRef.current = head;
  };

  // --- Decode the music file whenever the source URL changes ------------------
  useEffect(() => {
    const token = ++decodeTokenRef.current;
    // Any src change invalidates the currently-sounding bed.
    stopSource();
    if (!src) {
      bufferRef.current = null;
      return;
    }
    const ctx = getCtx();
    if (!ctx) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(src);
        const bytes = await res.arrayBuffer();
        const decoded = await ctx.decodeAudioData(bytes);
        // Drop if a newer src won the race (or this effect was cleaned up).
        if (cancelled || token !== decodeTokenRef.current) return;
        bufferRef.current = decoded;
        // If we're already playing when the decode lands, begin at the live head.
        const state = useRepurposeStore.getState();
        if (state.isPlaying) startAt(state.playhead);
      } catch {
        if (cancelled || token !== decodeTokenRef.current) return;
        bufferRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
    // getCtx / startAt / stopSource are stable refs-only closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // --- Drive start / stop / seek off the store (subscribe, no re-render) ------
  useEffect(() => {
    // Seed the play/head baseline from the current state.
    let prevPlaying = useRepurposeStore.getState().isPlaying;
    lastPlayheadRef.current = useRepurposeStore.getState().playhead;

    const unsub = useRepurposeStore.subscribe((state) => {
      const playing = state.isPlaying;
      const head = state.playhead;

      if (playing && !prevPlaying) {
        // PLAY transition -> (re)start for the current output head.
        startAt(head);
      } else if (!playing && prevPlaying) {
        // PAUSE / stop -> silence; next play recreates at the new offset.
        stopSource();
      } else if (playing) {
        // Still playing: a big playhead jump = a seek -> restart at new offset.
        if (Math.abs(head - lastPlayheadRef.current) > SEEK_JUMP_SEC) {
          startAt(head);
        } else {
          lastPlayheadRef.current = head;
        }
      }

      prevPlaying = playing;
    });

    // If we mounted mid-playback, get the bed sounding right away.
    if (prevPlaying) startAt(lastPlayheadRef.current);

    return () => {
      unsub();
      stopSource();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Live gain: update the GainNode without restarting ---------------------
  useEffect(() => {
    const gainNode = gainNodeRef.current;
    const ctx = audioCtxRef.current;
    if (!gainNode) return;
    if (ctx) {
      // setTargetAtTime avoids a click on abrupt gain changes.
      gainNode.gain.setTargetAtTime(gain, ctx.currentTime, 0.01);
    } else {
      gainNode.gain.value = gain;
    }
  }, [gain]);
}
