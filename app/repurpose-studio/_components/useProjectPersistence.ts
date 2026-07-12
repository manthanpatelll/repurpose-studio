"use client";

// ===========================================================================
// REPURPOSE STUDIO -- useProjectPersistence (per-project, disk-backed)
// ===========================================================================
// Loads + autosaves ONE project (identified by the route's projectId) to disk
// via the projects API, replacing the old single-slot sessionStorage snapshot.
// Projects live forever under ~/Downloads/repurpose-projects/<id>.json; a new
// video never overwrites an old one because each project is its own file under
// its own dated-slug URL.
//
// PROJECT ID SHAPES
//   - "new-<rand>": a provisional project the hub minted (no disk file yet). The
//     editor boots empty, the demo/manual ingest fills it, and on the first real
//     content we DERIVE a name, mint a dated slug (e.g.
//     "claude-routines-automation-13-jul-26"), CREATE the file, and
//     router.replace the URL to that slug.
//   - a real dated slug: loaded from disk on mount.
//
// LIFECYCLE
//   (A) LOAD -- effect keyed on projectId. new-* -> reset to empty. Same id we
//       already own (after a create's router.replace) -> no-op. Else fetch the
//       project, reset the store, hydrate the snapshot, reseed id counters.
//   (B) AUTOSAVE -- a debounced store subscription POSTs the snapshot to disk,
//       but only once the project actually EXISTS (has a built timeline or
//       footage). The FIRST such change auto-creates the project (see above).
//   (C) FLUSH -- pagehide/visibility-hidden beacons the latest snapshot so an
//       edit in the last <debounce> before a reload/close is not lost.
//   (D) [removed] -- no beforeunload confirm; autosave + (C) flush make it moot.
//   (E) WARM WORKER -- pre-spawn the export Worker on mount.
//
// KEPT VERBATIM from the old sessionStorage version: snapshotFromStore,
// migrateLegacyFraming, the src-re-derivation-from-sourcePath restore logic (so
// a reload never restores a dead blob: URL), reseedIdCounters, the caption
// self-heal, the footageNeedsReimport flagging, and the worker prespawn. Only
// the STORAGE BACKEND (sessionStorage -> disk) and the
// SCOPE (single slot -> per project) changed.
// ===========================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRepurposeStore, reseedIdCounters } from "@/lib/repurpose/store";
import { prespawnWorker, disposeWarmWorker } from "@/lib/export/workerBridge";
import type {
  Clip,
  FaceFraming,
  MediaAsset,
  MusicTrack,
  ProjectSnapshot,
  SfxTrack,
} from "@/lib/repurpose/types";
import { datedSlug, deriveShortTitle } from "./naming";

/** Debounce window (ms) for autosave writes -- collapses a drag/trim storm to one POST. */
const SAVE_DEBOUNCE_MS = 500;

/** A projectId is provisional (no disk file yet) when it carries the hub's "new-" prefix. */
function isProvisionalId(id: string): boolean {
  return id.startsWith("new-");
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

/** True when a footage path is a `blob:` object URL, which is dead after reload. */
function isDeadBlobPath(path: string | undefined | null): boolean {
  return typeof path === "string" && path.startsWith("blob:");
}

/** Build a snapshot (the persisted slice) from the current store state. */
function snapshotFromStore(): ProjectSnapshot {
  const s = useRepurposeStore.getState();
  return {
    // Per-scene framing (screenFraming / faceFraming) rides inside each clip, so
    // persisting `clips` persists it too -- no separate keyframe/global fields.
    clips: s.clips,
    duration: s.duration,
    splitRatio: s.splitRatio,
    screenGrade: s.screenGrade,
    faceGrade: s.faceGrade,
    playhead: s.playhead,
    inPoint: s.inPoint,
    outPoint: s.outPoint,
    loopPlayback: s.loopPlayback,
    footageMeta: s.footageMeta,
    words: s.words,
    captionsEnabled: s.captionsEnabled,
    captionStyle: s.captionStyle,
    captionBlocks: s.captionBlocks,
    snapEnabled: s.snapEnabled,
    markers: s.markers,
    deletedWordIndices: s.deletedWordIndices,
    overlays: s.overlays,
    sfxTrack: s.sfxTrack,
    musicTrack: s.musicTrack,
    mediaAssets: s.mediaAssets,
  };
}

/** A framing is neutral (identity) when it neither pans nor zooms. */
function isIdentityFraming(f: { x: number; y: number; scale: number }): boolean {
  return f.x === 0 && f.y === 0 && f.scale === 1;
}

/** Clamp a legacy framing into the store's valid pan/zoom ranges. */
function clampFraming(f: { x: number; y: number; scale: number }): FaceFraming {
  return {
    x: Math.min(1, Math.max(-1, f.x)),
    y: Math.min(1, Math.max(-1, f.y)),
    scale: Math.min(6, Math.max(1, f.scale)),
  };
}

/**
 * Migrate a LEGACY snapshot's flat pan/zoom onto per-clip framing (unchanged from
 * the old version). Old model: SCREEN pan/zoom as keyframes (`screenKeyframes`),
 * FACE as ONE global framing. New model: one static framing per scene on the clip.
 * Folds legacy values onto each kept clip so an old project keeps its zooms.
 */
function migrateLegacyFraming(clips: Clip[], snapshot: ProjectSnapshot): Clip[] {
  const legacyScreenKfs = snapshot.screenKeyframes ?? [];
  const legacyFaceRaw = snapshot.faceFraming ?? snapshot.faceKeyframes?.[0];
  const legacyFace =
    legacyFaceRaw && !isIdentityFraming(legacyFaceRaw)
      ? clampFraming(legacyFaceRaw)
      : undefined;

  if (legacyScreenKfs.length === 0 && !legacyFace) return clips;

  return clips.map((clip) => {
    if (!clip.kept) return clip;
    let next = clip;

    if (clip.screenFraming === undefined && legacyScreenKfs.length > 0) {
      const kf = legacyScreenKfs.find(
        (k) => k.t >= clip.timelineStart && k.t < clip.timelineEnd
      );
      if (kf && !isIdentityFraming(kf)) {
        next = { ...next, screenFraming: clampFraming(kf) };
      }
    }

    if (clip.faceFraming === undefined && legacyFace) {
      next = { ...next, faceFraming: legacyFace };
    }

    return next;
  });
}

/**
 * The current default Smart transition (kept in sync with ingest.ts and
 * lib/repurpose/fcpxml-import.ts). DESCRIPT-FEEL: a SUBTLE settle, never a pop.
 * `amount: 0.025` -> the incoming clip starts 2.5% larger and eases to normal
 * (compositor boost = 1 + amount*(1-e)), giving every real cut a gentle "landed"
 * motion even when framing matches -- the smooth, natural feel of Descript's
 * Smart Transition, far below a zoom "pop". ~0.4s natural matches Descript's soft
 * window.
 */
const NEW_DEFAULT_TRANSITION: NonNullable<Clip["transitionIn"]> = {
  type: "zoom-settle",
  durationSec: 0.4,
  amount: 0.025,
  easing: "natural",
};

/**
 * A continuous same-take join: two adjacent clips whose source is within this
 * many seconds are one take the timeline split (e.g. a caption boundary), NOT a
 * scene change. Those must carry NO transition -- a transition there is the
 * forced "pop after every scene" Manthan flagged. Mirrors CUT_GAP in the tool.
 */
const CUT_GAP = 0.4;

/** Is `tr` an auto-generated Smart transition (vs. a deliberate user choice we
 *  must never touch)? Auto shapes are the historical app defaults: the legacy 5%
 *  pop (0.05), the interim pure-ease (0), and the current subtle Descript-feel
 *  settle (0.025). A `type: "none"` (explicit hard cut), a slide, or any other
 *  amount is treated as user intent and preserved untouched. */
function isAutoTransition(tr: Clip["transitionIn"]): boolean {
  return (
    !!tr &&
    tr.type === "zoom-settle" &&
    (tr.amount === 0.05 || tr.amount === 0 || tr.amount === 0.025)
  );
}

/**
 * Bring a project's cuts to the "gentle ease on a REAL cut, NOTHING on a
 * continuous same-take join" rule -- and heal the OLD "pop on every cut" era.
 *
 * The old default put a 5% zoom-push on EVERY non-opening cut (and rule (2) here
 * force-added one to any kept clip missing it), so continuous speech the timeline
 * merely split read as a zoom pop after every line. Now:
 *   - CONTINUOUS join (source gap <= CUT_GAP): drop any AUTO transition -> a
 *     clean, jump-free cut. One take must read as one shot.
 *   - REAL cut (source gap > CUT_GAP): normalize any AUTO transition (legacy 5%
 *     pop or interim amount-0 ease) to the current subtle Descript-feel settle
 *     (NEW_DEFAULT_TRANSITION). We do NOT force-add one where absent.
 *
 * PRESERVED: the opening frame (nothing before it), an explicit `type: "none"`
 * hard cut, a slide, or any user-customized amount/duration (see isAutoTransition).
 * Idempotent: a clip already on the current default over a real cut is unchanged.
 */
function migrateSmartTransitions(clips: Clip[]): Clip[] {
  return clips.map((clip, i) => {
    const tr = clip.transitionIn;
    if (i === 0 || !isAutoTransition(tr)) return clip; // opening / user-owned

    const prev = clips[i - 1];
    const gap =
      prev && typeof prev.srcEnd === "number" && typeof clip.srcStart === "number"
        ? clip.srcStart - prev.srcEnd
        : Infinity; // unknown source -> treat as a real cut (keep a gentle ease)

    // Continuous same-take join -> no transition (kill the forced pop).
    // +1e-6 absorbs float error so a gap of exactly CUT_GAP counts as continuous.
    if (gap <= CUT_GAP + 1e-6) return { ...clip, transitionIn: undefined };

    // Real cut -> current subtle settle. No-op if it's already exactly that.
    if (
      tr &&
      tr.amount === NEW_DEFAULT_TRANSITION.amount &&
      tr.durationSec === NEW_DEFAULT_TRANSITION.durationSec
    ) {
      return clip;
    }
    return { ...clip, transitionIn: { ...NEW_DEFAULT_TRANSITION } };
  });
}

/**
 * Heal divergent per-clip `faceFraming` overrides left over from BEFORE the
 * face-cam sync toggle existed (or from a session with sync off). The face cam
 * is a locked camera -- Manthan flagged the pan/zoom EASING between two
 * different per-clip crops at every cut as a visible "jump"/"pop" on his face,
 * not the intended subtle Smart-transition settle (see `faceFramingAt` in
 * ../../../lib/repurpose/time-map.ts, which eases whenever two clips' framings
 * differ). Collapses every kept clip's `faceFraming` onto the FIRST one found
 * (deterministic, no picking/UI needed), so a reload of an old project reads as
 * one still face cam again. No-op when framings already agree or none is set.
 */
function migrateFaceFramingSync(clips: Clip[]): Clip[] {
  const kept = clips.filter((c) => c.kept);
  const first = kept.find((c) => c.faceFraming !== undefined)?.faceFraming;
  if (!first) return clips; // nobody has an override -> nothing to reconcile

  const allMatch = kept.every(
    (c) =>
      c.faceFraming !== undefined &&
      c.faceFraming.x === first.x &&
      c.faceFraming.y === first.y &&
      c.faceFraming.scale === first.scale
  );
  if (allMatch) return clips;

  return clips.map((c) =>
    c.kept && c.faceFraming !== first ? { ...c, faceFraming: { ...first } } : c
  );
}

/**
 * Default SCREEN zoom for every scene that has never been framed by hand:
 * 115%, BOTTOM-ANCHORED (Manthan, 2026-07-10). The whole point of the zoom is
 * to hide the macOS menu bar + Chrome tab strip + URL bar that live along the
 * TOP of his screen recordings: y=+1 pins the crop to the source's bottom
 * edge (crop center = center + y*maxOffset in the compositor, so +1 = bottom
 * flush with the split line) and the ~13% the 1.15x crop removes comes
 * entirely off the top -- exactly the browser chrome. Applied as a load-time
 * migration per the "every default change auto-migrates all saved projects"
 * rule: any kept clip with NO screenFraming at all gets {0, 1, 1.15}. A clip
 * with ANY explicit framing -- including one Manthan deliberately set back to
 * 100% -- is user intent and stays byte-for-byte, with ONE exception: the
 * short-lived center-anchored default {0, 0, 1.15} is
 * rewritten to the bottom-anchored form, healing projects that loaded during
 * the hour it existed. Reset framing clears back to undefined, so a reset
 * scene re-adopts this default on next load; that IS the default now.
 * Idempotent; runs on every project open, so future projects are covered the
 * first time they load.
 */
const DEFAULT_SCREEN_FRAMING = { x: 0, y: 1, scale: 1.15 } as const;
function migrateScreenZoomDefault(clips: Clip[]): Clip[] {
  return clips.map((c) => {
    if (!c.kept) return c;
    const f = c.screenFraming;
    const isOldCenterDefault =
      !!f && f.x === 0 && f.y === 0 && f.scale === 1.15;
    if (f !== undefined && !isOldCenterDefault) return c; // user-owned framing
    return { ...c, screenFraming: { ...DEFAULT_SCREEN_FRAMING } };
  });
}

/**
 * Apply a loaded snapshot to the store. This is the OLD restore block, lifted out
 * so both the disk-load path and a future importer can call it. It:
 *   - migrates legacy framing onto clips, then setClips (re-derives the timeline),
 *   - RE-DERIVES sfx/music/media `src` fresh from `sourcePath` so a reload never
 *     restores a dead blob: URL,
 *   - restores the plain non-derived slices (split/grades/captions/markers/etc.),
 *   - reseeds the id counters past every restored id,
 *   - self-heals caption blocks,
 *   - flags footageNeedsReimport when footage/overlays used dead blob: URLs.
 * Returns true when a re-import banner should show.
 */
function hydrateSnapshot(snapshot: ProjectSnapshot): boolean {
  const store = useRepurposeStore.getState();

  // MIGRATION: fold any legacy flat framing onto the clips, then upgrade any
  // dead-default (amount-0) Smart transitions to the new snappy 5% push so every
  // cut in an old project gains visible motion.
  const migratedClips = migrateScreenZoomDefault(
    migrateFaceFramingSync(
      migrateSmartTransitions(migrateLegacyFraming(snapshot.clips, snapshot))
    )
  );

  // setClips runs recomputeTimeline (idempotent on already-laid-out clips) and
  // re-derives duration.
  store.setClips(migratedClips);

  // SFX track -- re-derive `src` from `sourcePath` (never trust the persisted src).
  const restoredSfxTrack: SfxTrack | null | undefined =
    snapshot.sfxTrack === undefined
      ? undefined
      : snapshot.sfxTrack && snapshot.sfxTrack.sourcePath
        ? {
            ...snapshot.sfxTrack,
            src: `/api/repurpose/sfx?path=${encodeURIComponent(
              snapshot.sfxTrack.sourcePath
            )}`,
          }
        : null;

  // MUSIC track -- same safe pattern; music is served by the asset route.
  const restoredMusicTrack: MusicTrack | null | undefined =
    snapshot.musicTrack === undefined
      ? undefined
      : snapshot.musicTrack && snapshot.musicTrack.sourcePath
        ? {
            ...snapshot.musicTrack,
            src: `/api/repurpose/asset?path=${encodeURIComponent(
              snapshot.musicTrack.sourcePath
            )}`,
          }
        : null;

  // MEDIA BIN -- re-derive each asset's src (video route for videos, asset route else).
  const restoredMediaAssets: MediaAsset[] | undefined =
    snapshot.mediaAssets === undefined
      ? undefined
      : snapshot.mediaAssets.map((asset) =>
          asset.sourcePath
            ? {
                ...asset,
                src:
                  asset.kind === "video"
                    ? `/api/repurpose/video?path=${encodeURIComponent(asset.sourcePath)}`
                    : `/api/repurpose/asset?path=${encodeURIComponent(asset.sourcePath)}`,
              }
            : asset
        );

  // Restore the plain, non-derived slices. Transient UI state stays at defaults.
  useRepurposeStore.setState({
    splitRatio: snapshot.splitRatio,
    screenGrade: snapshot.screenGrade,
    faceGrade: snapshot.faceGrade,
    playhead: snapshot.playhead,
    inPoint: snapshot.inPoint,
    outPoint: snapshot.outPoint,
    loopPlayback: snapshot.loopPlayback,
    footageMeta: snapshot.footageMeta,
    ...(snapshot.words !== undefined ? { words: snapshot.words } : {}),
    ...(snapshot.captionsEnabled !== undefined
      ? { captionsEnabled: snapshot.captionsEnabled }
      : {}),
    ...(snapshot.captionStyle !== undefined
      ? { captionStyle: snapshot.captionStyle }
      : {}),
    ...(snapshot.captionBlocks !== undefined
      ? { captionBlocks: snapshot.captionBlocks }
      : {}),
    ...(snapshot.snapEnabled !== undefined
      ? { snapEnabled: snapshot.snapEnabled }
      : {}),
    ...(snapshot.markers !== undefined ? { markers: snapshot.markers } : {}),
    ...(snapshot.deletedWordIndices !== undefined
      ? { deletedWordIndices: snapshot.deletedWordIndices }
      : {}),
    ...(snapshot.overlays !== undefined ? { overlays: snapshot.overlays } : {}),
    ...(restoredSfxTrack !== undefined ? { sfxTrack: restoredSfxTrack } : {}),
    ...(restoredMusicTrack !== undefined ? { musicTrack: restoredMusicTrack } : {}),
    ...(restoredMediaAssets !== undefined ? { mediaAssets: restoredMediaAssets } : {}),
  });

  // Reseed id counters past every restored id (they reset to 0 on module re-eval).
  const seed = useRepurposeStore.getState();
  reseedIdCounters({
    clips: seed.clips,
    markers: seed.markers,
    overlays: seed.overlays,
    mediaAssets: seed.mediaAssets,
  });

  // SELF-HEAL captions: words present but no blocks -> chunk them now.
  const after = useRepurposeStore.getState();
  if (after.words.length > 0 && after.captionBlocks.length === 0) {
    after.rebuildCaptionBlocks();
  }

  // Flag dead blob footage/overlays so the UI can prompt a re-import.
  const meta = snapshot.footageMeta;
  const overlayNeedsReconnect = (snapshot.overlays ?? []).some((o) =>
    isDeadBlobPath(o.src)
  );
  return (
    overlayNeedsReconnect ||
    (!!meta && (isDeadBlobPath(meta.faceCamPath) || isDeadBlobPath(meta.screenPath)))
  );
}

/**
 * POST a project to disk. `mode:"create"` forces a collision-free id (so a new
 * project never overwrites an existing file whose slug matches); omit it for an
 * autosave upsert. Returns the saved metadata (authoritative id) or null.
 */
async function postProject(body: {
  id: string;
  name: string;
  createdAt?: string;
  snapshot: ProjectSnapshot;
  mode?: "create";
}): Promise<{ id: string; name: string; createdAt: string } | null> {
  try {
    const res = await fetch("/api/repurpose/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      project?: { id: string; name: string; createdAt: string };
    };
    return data.project ?? null;
  } catch {
    return null;
  }
}

/**
 * Per-project disk persistence. Mount once from the editor with the route's
 * projectId. Returns:
 *   - footageNeedsReimport: restored footage used dead blob: URLs -> nudge a re-pick.
 *   - projectName: the resolved (derived, then frozen) project title, or null.
 *   - ready: false until the initial load/404 resolves (first paint gate).
 */
export function useProjectPersistence(projectId: string): {
  footageNeedsReimport: boolean;
  projectName: string | null;
  ready: boolean;
} {
  const router = useRouter();
  const [footageNeedsReimport, setFootageNeedsReimport] = useState(false);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // The id of the project we currently hold in memory (a real dated slug once
  // created/loaded, or null while provisional). Guards the router.replace re-entry.
  const currentIdRef = useRef<string | null>(null);
  // True once a disk file exists for the current project.
  const createdRef = useRef(false);
  // Synchronous lock so a setClips storm can't fire concurrent auto-creates.
  const creatingRef = useRef(false);
  // Mirrors of the resolved name / createdAt for the autosave POST body.
  const projectNameRef = useRef<string | null>(null);
  const createdAtRef = useRef<string | undefined>(undefined);
  // True once the load effect has settled -- gates the autosave subscription so
  // hydration's setState storm doesn't POST straight back.
  const readyRef = useRef(false);

  // --- (E) WARM THE ENCODE WORKER -------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    prespawnWorker();
    return () => disposeWarmWorker();
  }, []);

  // --- (A) LOAD (keyed on projectId) ----------------------------------------
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    readyRef.current = false;

    const markReady = () => {
      if (cancelled) return;
      readyRef.current = true;
      setReady(true);
    };

    // Provisional new project: empty baseline, no disk file yet. The demo/manual
    // ingest path is allowed to run (hydrating stays false).
    if (isProvisionalId(projectId)) {
      useRepurposeStore.getState().resetProject();
      currentIdRef.current = null;
      createdRef.current = false;
      creatingRef.current = false;
      projectNameRef.current = null;
      createdAtRef.current = undefined;
      setProjectName(null);
      setFootageNeedsReimport(false);
      markReady();
      return () => {
        cancelled = true;
      };
    }

    // The URL just caught up to a project we already hold in memory (the
    // router.replace right after auto-create). Do NOT re-fetch/reset -- that would
    // wipe the in-progress edit. Just settle.
    if (projectId === currentIdRef.current) {
      markReady();
      return () => {
        cancelled = true;
      };
    }

    // A real dated slug we don't hold yet: load it from disk.
    const store = useRepurposeStore.getState();
    store.setHydrating(true);

    (async () => {
      let found: { name: string; snapshot: ProjectSnapshot } | null = null;
      try {
        const res = await fetch(
          `/api/repurpose/projects/${encodeURIComponent(projectId)}`
        );
        if (res.ok) {
          const data = (await res.json()) as {
            project?: {
              id: string;
              name: string;
              createdAt: string;
              snapshot: ProjectSnapshot;
            };
          };
          if (data.project) {
            found = { name: data.project.name, snapshot: data.project.snapshot };
            createdAtRef.current = data.project.createdAt;
          }
        }
      } catch {
        // Network error -> treat as not-found (empty editor under this id).
      }

      if (cancelled) {
        useRepurposeStore.getState().setHydrating(false);
        return;
      }

      // Reset the store before applying the target (clean switch between projects).
      useRepurposeStore.getState().resetProject();

      if (found) {
        const needsReimport = hydrateSnapshot(found.snapshot);
        currentIdRef.current = projectId;
        createdRef.current = true;
        creatingRef.current = false;
        projectNameRef.current = found.name;
        setProjectName(found.name);
        setFootageNeedsReimport(needsReimport);
      } else {
        // Valid-looking slug with no disk record (a mid-create reload). Treat like
        // an empty editor but re-create under THIS id once a name derives.
        currentIdRef.current = null;
        createdRef.current = false;
        creatingRef.current = false;
        projectNameRef.current = null;
        createdAtRef.current = undefined;
        setProjectName(null);
        setFootageNeedsReimport(false);
      }

      useRepurposeStore.getState().setHydrating(false);
      markReady();
    })();

    return () => {
      cancelled = true;
    };
    // Re-run whenever the route's project changes.
  }, [projectId]);

  // --- auto-create the dated-slug project on first real content --------------
  const createProjectFromStore = useCallback(async () => {
    if (creatingRef.current || createdRef.current) return;
    const s = useRepurposeStore.getState();
    const name = deriveShortTitle(s.words);
    // No derivable title yet -> defer; a later store change retries.
    if (!name) return;

    creatingRef.current = true; // synchronous lock BEFORE the await
    const nowIso = new Date().toISOString();
    // If the URL already carried a valid slug (a 404 mid-create reload), re-use it;
    // otherwise mint a fresh dated slug from the derived name + the real clock.
    const baseId =
      !isProvisionalId(projectId) && currentIdRef.current === null
        ? projectId
        : datedSlug(name, new Date());

    const saved = await postProject({
      id: baseId,
      name,
      createdAt: nowIso,
      snapshot: snapshotFromStore(),
      // Force a collision-free id: a new project must never overwrite an existing
      // one, even when the derived name+date slug is identical (append -2/-3).
      mode: "create",
    });

    if (!saved) {
      // Create failed (offline/disk error) -> unlock and let a later change retry.
      creatingRef.current = false;
      return;
    }

    currentIdRef.current = saved.id; // authoritative -- may be -2/-3 suffixed
    projectNameRef.current = saved.name;
    createdAtRef.current = saved.createdAt;
    createdRef.current = true;
    creatingRef.current = false;
    setProjectName(saved.name);

    // NOTE: no catch-up POST needed here. The create wrote the snapshot at create
    // time; the level-triggered autosave (effect B) persists any later change from
    // the same ingest burst (footageMeta, mediaAssets, ...) on the next tick,
    // because every store change bumps storeVersion and the saver converges disk to
    // the latest store state regardless of ordering.

    // Reflect the real dated slug in the URL. The load effect's
    // `projectId === currentIdRef.current` guard makes this a no-op re-render.
    if (saved.id !== projectId) {
      router.replace(`/repurpose-studio/${saved.id}`);
    }
  }, [projectId, router]);

  // --- (B) AUTOSAVE (LEVEL-TRIGGERED -- cannot drop a change) -----------------
  // Why level-triggered, not edge-triggered: the old design used a `dirty` flag
  // that some early-return paths (notably the create-in-flight lock) forgot to
  // set, so store changes that landed during a save/create window were silently
  // dropped -- that lost footageMeta, and mediaAssets/overlays/music the same way.
  //
  // This version can NEVER drop a change. Every store change bumps a monotonic
  // `storeVersion`. A single debounced saver saves the CURRENT snapshot whenever
  // `storeVersion !== savedVersion`, then re-checks after the async POST resolves;
  // if anything changed while that POST was in flight, it saves again. There is no
  // per-field logic and no lock that can swallow an update -- convergence to
  // "disk == latest store" is guaranteed for ANY field, in ANY order.
  useEffect(() => {
    if (!isBrowser()) return;

    let storeVersion = 0; // bumped on every store change
    let savedVersion = 0; // the version last successfully persisted
    let saving = false; // a POST is in flight
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Perform one save of the current store state, then loop if more changes
    // arrived during the POST (so an in-flight-window change is never lost).
    const runSave = async () => {
      if (saving) return;
      const id = currentIdRef.current;
      const name = projectNameRef.current;
      if (!id || !name) return;
      saving = true;
      try {
        while (savedVersion !== storeVersion) {
          const versionAtSend = storeVersion;
          const ok = await postProject({
            id: currentIdRef.current ?? id,
            name: projectNameRef.current ?? name,
            createdAt: createdAtRef.current,
            snapshot: snapshotFromStore(),
          });
          // Only advance savedVersion on a confirmed write; a failed POST leaves
          // savedVersion behind so the next tick retries.
          if (ok) savedVersion = versionAtSend;
          else break;
        }
      } finally {
        saving = false;
      }
    };

    const scheduleSave = () => {
      // Don't autosave until the initial load settled (avoid a hydrate-driven POST).
      if (!readyRef.current) return;
      const s = useRepurposeStore.getState();
      // "Project exists" = a built timeline (not just words) OR footage loaded.
      const exists = s.clips.length > 0 || s.footageMeta != null;
      if (!exists) return;

      // Any qualifying change bumps the version -- this is the ONLY place a change
      // is recorded, so nothing downstream can forget to.
      storeVersion++;

      // Not yet created on disk -> create first (createProjectFromStore sets
      // createdRef + the id/name refs), then run one level-triggered save. We do
      // NOT optimistically advance savedVersion here: the create snapshotted at
      // create time, but later changes from the same ingest burst (footageMeta,
      // mediaAssets) may have arrived after that snapshot. Leaving savedVersion at
      // 0 forces runSave() to persist the CURRENT state after create, converging
      // disk to the true latest -- so nothing from the burst is ever lost.
      if (!createdRef.current) {
        void createProjectFromStore().then(() => {
          if (createdRef.current) void runSave();
        });
        return;
      }

      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void runSave();
      }, SAVE_DEBOUNCE_MS);
    };

    const flushSave = () => {
      // Nothing unsaved -> no-op.
      if (savedVersion === storeVersion) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const id = currentIdRef.current;
      const name = projectNameRef.current;
      if (!id || !name) return;
      // sendBeacon is the reliable unload-time POST (a normal fetch is cancelled).
      try {
        const body = JSON.stringify({
          id,
          name,
          createdAt: createdAtRef.current,
          snapshot: snapshotFromStore(),
        });
        const blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon("/api/repurpose/projects", blob)) {
          savedVersion = storeVersion;
        }
      } catch {
        void runSave();
      }
    };

    const unsubscribe = useRepurposeStore.subscribe(scheduleSave);

    const onPageHide = () => flushSave();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushSave();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      flushSave();
      if (timer !== null) clearTimeout(timer);
    };
  }, [createProjectFromStore]);

  // --- (D) [removed] no beforeunload confirm ---------------------------------
  // The old native "Reload site? Changes may not be saved" confirm is gone:
  // every edit autosaves (debounced subscription above) and section (C) flushes
  // the latest snapshot on pagehide / visibility-hidden, so a reload or close
  // never loses work. The prompt was pure friction. Do not re-add it.

  return { footageNeedsReimport, projectName, ready };
}
