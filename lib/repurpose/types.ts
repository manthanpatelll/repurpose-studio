// ===========================================================================
// REPURPOSE STUDIO -- shared types
// ===========================================================================
// Contract file: other agents (timeline UI, compositor, transcription engine)
// build against these types. Do not change field names/shapes without
// updating all three consumers. See lib/repurpose/store.ts for the store
// that owns Clip[]/keyframes state built from these types.
// ===========================================================================

// ProjectSnapshot (below) references the caption look + chunked blocks. These are
// type-only imports (erased at build), so the captions.ts <-> types.ts cycle they
// create is harmless.
import type { CaptionStyle, CaptionBlock } from "./captions";

/** A single transcribed word with its position in the raw source file, in seconds. */
export interface Word {
  text: string;
  start: number;
  end: number;
}

/**
 * A "take" is a line the speaker repeated (a retake). `occurrences` lists every
 * time that line was spoken in the raw footage; `keeperIndex` is which
 * occurrence (index into `occurrences`) is the one selected to appear in the
 * final short. The transcription engine detects these; the timeline UI lets
 * Manthan flip `keeperIndex` to pick a different retake.
 */
export interface Take {
  text: string;
  occurrences: { start: number; end: number }[];
  keeperIndex: number;
}

/** Metadata describing the raw dual-track source footage for a Short. */
export interface FootageMeta {
  faceCamPath: string;
  screenPath: string;
  fps: number;
  width: number;
  height: number;
  durationSec: number;
}

/**
 * A per-cut motion transition, modeled after Descript's "Smart transition"
 * (a layout-aware zoom/move tween, NOT a fade/crossfade). It is the INCOMING
 * transition -- the motion that plays as this clip enters at its
 * `timelineStart`. A cut between clip A -> B is therefore described by B's
 * `transitionIn`.
 *
 * The default effect is "zoom-settle": the incoming frame starts scaled up by
 * `amount` and eases to 1.0 over `durationSec` (Descript's 0.8s ease-in-out),
 * reading as a smooth camera push. `direction` swaps the scale push for a small
 * positional match-move slide so alternating cuts don't pulse identically.
 * This needs ONLY the incoming frame, so it composites cleanly with the two
 * shared <video> elements (no outgoing-frame snapshot required).
 */
export interface ClipTransition {
  type: "none" | "zoom-settle" | "slide";
  /** Total transition window in seconds (Descript default 0.8). */
  durationSec: number;
  /** Push strength: scale-up fraction for zoom-settle, or slide fraction for slide. e.g. 0.06 = 6%. */
  amount: number;
  /** Slide direction for `type: "slide"` (ignored by zoom-settle). */
  direction?: "left" | "right";
  /** Easing curve. "natural" = ease-in-out cubic (Descript default); "bounce" = ease-out-back. */
  easing?: "natural" | "bounce";
}

/**
 * A face-cam FRAMING -- one static pan/zoom for the face (bottom) region.
 * Coordinate contract: `x`/`y` are normalized crop-center offsets in [-1, 1]
 * (0,0 = centered, no pan), `scale` a zoom multiplier (>= 1). The shared shape
 * for BOTH regions' per-scene framing (`Clip.faceFraming` / `Clip.screenFraming`).
 *
 * WHY NOT KEYFRAMES: the face cam never moves (locked camera, speaker in the
 * same spot for the whole recording), so ONE framing fits every scene. The
 * editor keeps a single GLOBAL FaceFraming that paints the face region across
 * the entire reel; a scene that needs its own framing "unfreezes" by carrying a
 * `Clip.faceFraming` override (exactly the `Clip.splitRatio` pattern, inverted
 * default: split is per-scene first, face framing is global first). The SCREEN
 * region keeps real per-scene keyframes -- each scene zooms a different part of
 * the screen recording.
 */
export interface FaceFraming {
  x: number;
  y: number;
  scale: number;
}

/**
 * A mid-clip ZOOM PUNCH-IN -- the signature short-form emphasis move: a
 * transient scale boost that eases IN, HOLDS punched, then eases back OUT,
 * WITHOUT splitting the clip. It is a RENDER-TIME DECORATOR layered on top of a
 * region's resolved base framing (`screenFraming` / `faceFraming`), exactly like
 * `transitionIn` -- plain optional data on the clip, so it survives
 * ripple/persistence/undo for free and never moves footage in time.
 *
 *  - `atSrc`:   SOURCE-time center of the punch (seconds in the raw file, same
 *    space as `srcStart`/`srcEnd`). Anchoring in source time means the punch
 *    rides ripple/reorder -- wherever this scene's footage lands on the output
 *    timeline, the punch fires over the SAME frames.
 *  - `amount`:  EXTRA scale at full punch, as a fraction (0.25 = +25% zoom on top
 *    of the region's base framing scale). Folded multiplicatively:
 *    drawScale = baseScale * (1 + amount) at the peak.
 *  - `holdSec`: how long (seconds) the punch stays fully in before easing back.
 *  - `ease`:    rise curve. "natural" = ease-in-out cubic (default); "bounce" =
 *    ease-out-back, a subtle spring pop into the punch. The fall is always
 *    natural so the settle never overshoots the base framing.
 *
 * Evaluated by `punchScaleAt` in ./time-map.ts, shared verbatim by preview +
 * export (both fold its result into the region transform they already build).
 */
export interface ClipPunch {
  /** SOURCE-time center of the punch (seconds, `srcStart`/`srcEnd` space). */
  atSrc: number;
  /** Extra scale at the peak, as a fraction (e.g. 0.25 = +25%). */
  amount: number;
  /** Seconds the punch holds fully in before easing back out. */
  holdSec: number;
  /** Rise easing. "natural" = ease-in-out cubic (default); "bounce" = ease-out-back. */
  ease?: "natural" | "bounce";
}

/**
 * A single ordered segment placed on the output timeline.
 *
 * - `srcStart`/`srcEnd`: position (seconds) in the raw source file this clip
 *   was cut from.
 * - `timelineStart`/`timelineEnd`: position (seconds) in the assembled output
 *   short. These are derived/recomputed (ripple) whenever a clip before them
 *   is trimmed, deleted, restored, or reordered -- never hand-set except by
 *   the store's own recompute step.
 * - `kept`: false means the clip has been deleted from the output (soft
 *   delete -- it stays in `clips` so it can be restored, but contributes 0
 *   duration to the timeline and is skipped during ripple/export).
 * - `isKeeperTake`: true when this clip is the selected occurrence of a
 *   retake (see `Take.keeperIndex`). Lets the timeline UI badge/highlight it
 *   differently from a plain `kind: 'take'` clip that was never repeated.
 */
export interface Clip {
  id: string;
  kind: "take" | "silence";
  label: string;
  srcStart: number;
  srcEnd: number;
  timelineStart: number;
  timelineEnd: number;
  kept: boolean;
  isKeeperTake: boolean;
  /**
   * Every retake of this line in the raw footage, chronological, as {start,end}
   * source-time ranges. Empty for silence clips and single-take lines. Powers
   * the transcript panel's Take chooser -- flipping keeperIndex re-cuts the clip.
   */
  occurrences: { start: number; end: number }[];
  /** Index into `occurrences` of the take currently used. -1 for silence. */
  keeperIndex: number;
  /**
   * Motion transition played as this clip enters (the cut from the previous
   * clip into this one). Optional -- absent = a hard cut. Owned by the incoming
   * clip so a boundary is described once. Survives ripple/persistence for free
   * (plain optional data on the clip).
   */
  transitionIn?: ClipTransition;
  /**
   * Per-scene split ratio -- the fraction of frame height given to the SCREEN
   * (top) half for THIS clip, overriding the editor's global default. Optional:
   * absent = "use the global `splitRatio`", so a scene only carries a value once
   * Manthan drags the coral handle while it is the active clip. Lets each scene
   * frame its face-cam/screen split independently (one scene tucks the face up,
   * the next gives it more room) instead of one split for the whole reel. At a
   * cut the Smart transition eases from the outgoing clip's resolved split to
   * this one's (see `splitRatioAt` in ./time-map.ts). Clamped 0.4-0.6 like the
   * global. Render-time only -- never ripples the timeline or remaps keyframes.
   * Survives ripple/persistence/undo for free (plain optional data on the clip,
   * exactly like `transitionIn`).
   */
  splitRatio?: number;
  /**
   * Lineage id of the ORIGINAL take a fragment descends from -- used by
   * Stage-3 auto-merge to rejoin same-take fragments (a kept clip that a word
   * delete split into pieces all share the parent's `originId`, so consecutive
   * survivors that came from one continuous take can be recombined). Absent =
   * the clip is its own lineage (it was never split from a parent). Plain
   * optional data, so it survives ripple/persistence/undo for free, exactly
   * like `transitionIn`/`splitRatio`.
   */
  originId?: string;
  /**
   * Per-scene face-cam framing (pan/zoom of the bottom region for THIS scene).
   * Absent = this scene frames the face as shot (identity -- no pan, no zoom).
   * A scene carries a value once Manthan drags/scrolls the face region while it
   * is the active clip. At a cut the Smart transition eases from the outgoing
   * clip's resolved framing to this one's (see `faceFramingAt` in ./time-map.ts)
   * whenever the two differ; identical framings read as an instant cut.
   * Render-time only -- never ripples the timeline. Survives
   * ripple/persistence/undo for free (plain optional data on the clip, exactly
   * like `transitionIn`/`splitRatio`).
   */
  faceFraming?: FaceFraming;
  /**
   * Per-scene SCREEN framing (pan/zoom of the top region for THIS scene) -- the
   * screen counterpart to {@link faceFraming}, same shape and same contract.
   * Absent = this scene frames the screen as shot (identity). A scene carries a
   * value once Manthan drags to pan / scrolls to zoom the screen region while it
   * is the active clip. At a cut the Smart transition eases from the previous
   * scene's resolved screen framing to this one's (see `screenFramingAt` in
   * ./time-map.ts) whenever the two differ. This REPLACES the old per-scene
   * keyframe track: one static framing per scene, eased across cuts, no diamonds.
   * Render-time only -- never ripples the timeline. Survives
   * ripple/persistence/undo for free, exactly like `transitionIn`/`splitRatio`.
   */
  screenFraming?: FaceFraming;
  /**
   * Mid-clip SCREEN zoom punch-in (a transient scale envelope on the top region),
   * or absent for none. A RENDER-TIME DECORATOR on top of the resolved
   * `screenFraming` -- eased in, held, eased out around `atSrc` -- that emphasizes
   * a detail WITHOUT splitting the clip. Plain optional data, so it survives
   * ripple/persistence/undo for free, exactly like `transitionIn`/`screenFraming`.
   * Never ripples the timeline (draw-time only). Evaluated by `punchScaleAt` in
   * ./time-map.ts, folded into the region transform by the compositor's callers.
   */
  screenPunch?: ClipPunch;
  /**
   * Mid-clip FACE zoom punch-in -- the face-region twin of {@link screenPunch},
   * same shape and same contract (a transient scale envelope on the bottom
   * region, layered on the resolved `faceFraming`). Render-time only, survives
   * ripple/undo for free.
   */
  facePunch?: ClipPunch;
  /**
   * True when this clip is a MANUAL sub-scene the user carved with `/` (split at
   * the playhead), as opposed to an auto-cut keeper scene. Purely a UI marker:
   * the timeline color-codes manual sub-scenes distinctly so Manthan can see the
   * "layers" he authored vs the auto-cut boundaries. Functionally identical to
   * any other take clip. Absent = an auto-cut scene.
   */
  manualScene?: boolean;
}

/**
 * A free 2D transform for a free-floating overlay, expressed in NORMALIZED
 * output space so it renders identically at preview resolution and at 1080p/4K
 * export (the compositor multiplies these fractions by the output pixel size).
 *
 *  - x, y: the overlay CENTER as a fraction of output width/height (0..1).
 *    0.5,0.5 = dead center. Allowed to run slightly outside 0..1 so an asset can
 *    bleed off an edge on purpose.
 *  - scale: the overlay's natural width as a FRACTION OF OUTPUT WIDTH at this
 *    scale. Height is derived from the media's intrinsic aspect (naturalWidth /
 *    naturalHeight), so aspect ratio is never distorted.
 *  - rotation: DEGREES, clockwise, about the overlay center. (Degrees, not
 *    radians -- the compositor converts once at draw time.)
 */
export interface OverlayTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

/**
 * Payload for the attribute clipboard ("copy position" Cmd/Ctrl+C -> "paste
 * attributes" Cmd/Ctrl+Shift+V, Descript's chord). Same-kind paste only, like
 * Descript: a scene's framing set onto a scene, an overlay's transform onto an
 * overlay. Clip framing fields hold the RESOLVED values visible at copy time
 * (the inherit-from-previous-scene chain already walked); a framing left
 * undefined means "source showed the base default" and is skipped on paste so
 * a paste never clears the target's own override.
 */
export type AttributeClipboard =
  | {
      kind: "clip";
      faceFraming?: FaceFraming;
      screenFraming?: FaceFraming;
      splitRatio: number;
    }
  | { kind: "overlay"; transform: OverlayTransform; opacity: number };

/**
 * A free-floating external media layer composited ON TOP of the two base
 * regions (face + screen). An Overlay is a SEPARATE top-level concept, never a
 * Clip: it carries its own media src, floats anywhere on the 9:16 canvas, may
 * overlap other overlays with a z-order, and NEVER ripples with clip/word edits.
 * Overlays live in their own output-time window, clamped to the project end.
 *
 * Video overlays are ALWAYS muted -- an overlay never emits or mixes any audio,
 * ever (`muted` is a permanent property, not a deferral). Export audio stays
 * face-cam only.
 */
export interface Overlay {
  /** Stable id (assigned by the store on add, e.g. `ovl-N`). */
  id: string;
  kind: "image" | "video";
  /**
   * Streaming URL the <img>/<video> loads. A stable proxied path
   * (`/api/repurpose/video?path=...` after a copy-to-disk import) so the overlay
   * survives reload -- NEVER a bare blob: URL in the persisted state (a blob URL
   * dies on reload). A blob: URL is only ever a transient in-session fallback.
   */
  src: string;
  /**
   * Absolute on-disk path of the copied asset (the file `src` proxies), when
   * known. Lets persistence/export re-derive a fresh proxy URL after reload.
   * Absent when the overlay is still on a transient blob: fallback.
   */
  sourcePath?: string;
  /** Intrinsic media pixel width (for aspect + hit-test). */
  naturalWidth: number;
  /** Intrinsic media pixel height (for aspect + hit-test). */
  naturalHeight: number;
  /**
   * OUTPUT-timeline window (seconds) this overlay is visible in. Hand-set and
   * free -- clamped to [0, duration], never rippled by clip/word edits.
   */
  timelineStart: number;
  timelineEnd: number;
  /**
   * For kind:"video" only -- the in-point inside the source file (seconds). The
   * frame shown at output time t is src frame `srcStart + (t - timelineStart)`.
   * 0 for images.
   */
  srcStart: number;
  /**
   * The source media's full intrinsic duration (seconds) for kind:"video" -- the
   * available footage a start-trim advances into (srcStart clamps against this).
   * 0 for images (a still has no duration).
   */
  srcDuration: number;
  /** Free affine transform in normalized output space. */
  transform: OverlayTransform;
  /**
   * Stacking order AMONG OVERLAYS ONLY; higher draws later (on top). Dense-packed
   * 0..N-1 by the store so gaps never grow. The base face+screen composite is
   * always below every overlay.
   */
  zIndex: number;
  /**
   * Static opacity 0..1 (default 1). The ONE place the compositor touches
   * globalAlpha -- overlays only, never the base composite. This is a constant
   * asset property, NOT a crossfade (the no-fade convention is preserved because
   * it never tweens at a cut).
   */
  opacity: number;
  /**
   * Video overlays are ALWAYS muted -- true for kind:"video", absent for images.
   * A permanent rule, never a deferral: an overlay contributes no audio, ever.
   */
  muted?: true;
  /**
   * Which split-screen band the overlay is CLIPPED to when composited.
   *   - "screen" (default for every added/imported overlay): clipped to the TOP
   *     screen-recording band, so a cover-sized overlay fills that panel and never
   *     bleeds onto the face cam below. Bleeding off the top/left/right frame edge
   *     is fine (that's cover-crop).
   *   - "face": clipped to the bottom face band.
   *   - "free" / absent: NOT clipped -- draws across the whole 9:16 frame (legacy
   *     behavior). Absent is treated as "free" by the compositor for back-compat,
   *     but the store now stamps "screen" on new overlays so the DEFAULT is
   *     screen-covered. The user can still freely drag/resize/rotate afterward;
   *     `band` only controls the clip region, not the transform.
   */
  band?: "screen" | "face" | "free";
}

/**
 * A canvas-object selection target: one of the two base regions (face/screen)
 * or a specific overlay. Derived helper the canvas selection UI reads via
 * `getSelectedObject()`; the store keeps the two ids (`selectedClipId` /
 * `selectedOverlayId`) as the mutually-exclusive source of truth.
 */
export type SelectedObject =
  | { type: "overlay"; id: string }
  | { type: "clip"; id: string };

/**
 * A timeline MARKER -- a labeled pin on the ruler at an OUTPUT-timeline time
 * (`t`, seconds). A bookmark for a beat / chapter / "fix this" note, exactly like
 * CapCut/Premiere/Descript markers. Pinned to output time (NOT rippled with clip
 * edits): it marks a moment in the assembled short, not a piece of source footage.
 */
export interface Marker {
  /** Stable id (assigned by the store on add). */
  id: string;
  /** Position on the OUTPUT timeline, seconds. */
  t: number;
  /** Optional short label shown on hover / in a future marker list. */
  label?: string;
  /** Optional accent color (defaults to coral in the UI). */
  color?: string;
}

/**
 * The reel's generated SOUND-EFFECTS track -- a single full-length WAV rendered
 * by the /soundeffects engine and baked into the preview + exported MP4. Created
 * on demand when Manthan clicks the "Sound Effects" button; there is at most ONE
 * (the store keeps `sfxTrack: SfxTrack | null`), spanning the whole output
 * timeline (0..duration) rather than a set of draggable per-effect blocks.
 *
 * It sits on the Audio row BELOW the clip track (Overlays on top -> Clips ->
 * Audio at the bottom) and is rendered as a green block so it reads distinctly
 * from coral clips / violet overlays. Purely an audio layer -- it never draws to
 * the canvas and never ripples with clip/word edits (like {@link Overlay}, it is
 * placed in OUTPUT time and clamped to the reel bounds).
 *
 * PERSISTENCE (mirrors {@link Overlay}): `src` is a STABLE proxied URL
 * (`/api/repurpose/sfx?path=...`) so the track survives reload -- never a bare
 * blob: URL. `sourcePath` is the absolute on-disk WAV, so persistence can
 * re-derive a fresh proxy URL after a reload.
 */
export interface SfxTrack {
  /** Stable proxied streaming URL the preview/export loads (never a blob: URL). */
  src: string;
  /** Absolute on-disk path of the rendered WAV (re-derives `src` after reload). */
  sourcePath: string;
  /** Track length in seconds -- matches the reel's output duration at render time. */
  durationSec: number;
  /**
   * Linear playback gain applied on top of the engine's per-effect mix (the
   * engine already bakes click 50% / whoosh 30% / else 20%). 1 = as rendered.
   * Lets Manthan pull the whole SFX bed up/down under the VO without re-rendering.
   */
  gain: number;
}

/**
 * The reel's BACKGROUND-MUSIC track -- a single music file Manthan adds MANUALLY
 * (unlike the auto-generated {@link SfxTrack}). There is at most ONE (the store
 * keeps `musicTrack: MusicTrack | null`). It plays under the whole reel from
 * `startAtSec`, and like the SFX track it's baked into the preview + exported MP4
 * audio and never draws to the canvas / never ripples with clip edits.
 *
 * LAYOUT: the Music row sits between the clip track and the SFX row -- top to
 * bottom the timeline reads Overlays -> Clips -> Music -> SFX (SFX stays last).
 * Rendered as a distinct color (indigo) so it reads apart from the green SFX row.
 *
 * PERSISTENCE (mirrors {@link Overlay} / {@link SfxTrack}): `src` is a STABLE
 * proxied URL (`/api/repurpose/asset?path=...`) so it survives reload -- never a
 * bare blob: URL. `sourcePath` is the absolute on-disk audio file, so persistence
 * re-derives a fresh proxy URL after a reload.
 */
export interface MusicTrack {
  /** Stable proxied streaming URL the preview/export loads (never a blob: URL). */
  src: string;
  /** Absolute on-disk path of the copied audio file (re-derives `src` after reload). */
  sourcePath: string;
  /** Display name (the picked file's name) for the timeline block + inspector. */
  name: string;
  /** The music file's full intrinsic duration (seconds). */
  srcDuration: number;
  /**
   * OUTPUT-timeline second the music STARTS at (default 0 = plays from the reel
   * open). The frame heard at output time t is source frame `t - startAtSec`.
   * Clamped to [0, duration]; music past the reel end is simply not heard.
   */
  startAtSec: number;
  /** Linear playback gain (0..2, default 1). Pulls the music bed up/down under the VO. */
  gain: number;
}

/**
 * A MEDIA BIN entry -- one imported asset held in the project's "Files" panel so
 * it can be RE-USED without re-importing. Descript's Files list: every media file
 * you bring into the project (an overlay image/video, a music file, an SFX WAV, a
 * voice clip) is registered here once, then a click drops a fresh instance onto
 * the timeline (image/video -> overlay at the playhead; audio -> the music track).
 *
 * This is PROJECT-SCOPED, not a cross-project library: it lives on the store and
 * is saved in the same sessionStorage snapshot as the rest of the editor (never a
 * global on-disk catalog). It never draws to the canvas and never ripples with
 * clip edits -- it is a passive inventory, like {@link Overlay}/{@link SfxTrack}.
 *
 * PERSISTENCE (mirrors {@link Overlay}): `src` is a STABLE proxied URL after the
 * copy-to-disk import, never a bare blob: URL; `sourcePath` is the absolute
 * on-disk file so persistence can RE-DERIVE a fresh `src` after reload.
 */
export interface MediaAsset {
  /** Stable id (assigned by the store on add, e.g. `asset-N`). */
  id: string;
  /** Broad media class -- decides how a click places it (overlay vs. audio track). */
  kind: "image" | "video" | "audio";
  /** Original picked file name, shown in the bin row (e.g. "Gradient-BG-1.png"). */
  name: string;
  /**
   * Streaming URL an <img>/<video>/<audio> loads. A stable proxied path
   * (`/api/repurpose/asset?path=...` for images/audio, `/api/repurpose/video?path=...`
   * for videos) so the entry survives reload -- NEVER a bare blob: URL in persisted
   * state. A blob: URL is only ever a transient in-session fallback.
   */
  src: string;
  /**
   * Absolute on-disk path of the copied asset (the file `src` proxies). Lets
   * persistence re-derive a fresh proxy URL after reload. Absent only when the
   * disk copy failed and the entry is on a transient blob: fallback.
   */
  sourcePath?: string;
  /** Intrinsic pixel width (image/video only) -- carried so a placed overlay keeps aspect. */
  naturalWidth?: number;
  /** Intrinsic pixel height (image/video only). */
  naturalHeight?: number;
  /** Source duration in seconds (video/audio only; 0/absent for stills). */
  srcDuration?: number;
}

/**
 * READ-ONLY legacy shape for migrating OLD snapshots. The pan/zoom keyframe model
 * was removed in favour of one static framing per scene (Clip.screenFraming /
 * Clip.faceFraming), so `PanZoomKeyframe` no longer exists. A snapshot saved by an
 * older build still carries these; the persistence hook reads them once on restore
 * to seed the per-clip framing, then never writes them again.
 */
export interface LegacyKeyframe {
  id?: string;
  t: number;
  x: number;
  y: number;
  scale: number;
}

/**
 * The serializable slice of the editor store that is PERSISTED per project. Every
 * field is plain JSON (numbers, strings, booleans, and arrays of the same) -- no
 * functions, no class instances -- so JSON.stringify round-trips it losslessly.
 * Transient UI-only state (isPlaying, selectedClipId, undo history) is deliberately
 * excluded: it resets to a clean paused/no-selection state on load.
 *
 * This is the `snapshot` field of a ProjectFile on disk (lib/repurpose/projects.ts)
 * AND the exact shape `snapshotFromStore()` builds / the restore path consumes in
 * app/repurpose-studio/_components/useProjectPersistence.ts. It lives HERE (not in
 * the client hook) so the server disk-store and the client hook share ONE source of
 * truth without a client->server import.
 */
export interface ProjectSnapshot {
  // Per-scene framing (screenFraming / faceFraming) rides inside each clip, so
  // persisting `clips` persists it too -- no separate keyframe/global fields.
  clips: Clip[];
  duration: number;
  splitRatio: number;
  screenGrade: string;
  faceGrade: string;
  // LEGACY (optional, read-only). Older builds stored per-scene SCREEN pan/zoom as
  // keyframes here; the current model puts one static framing per scene on `clips`
  // (Clip.screenFraming), so new snapshots never write this -- kept only to migrate
  // an old snapshot on restore.
  screenKeyframes?: LegacyKeyframe[];
  // LEGACY (optional, read-only). Pre-faceFraming builds wrote per-keyframe face
  // motion here; used only to seed the per-clip face framing migration.
  faceKeyframes?: LegacyKeyframe[];
  // LEGACY (optional, read-only). A former ONE global face framing. Migrated onto
  // each clip's `faceFraming` on restore. New snapshots never write this.
  faceFraming?: FaceFraming;
  playhead: number;
  inPoint: number | null;
  outPoint: number | null;
  loopPlayback: boolean;
  footageMeta: FootageMeta | null;
  // Captions: the raw word-level transcript plus the caption look + chunked blocks.
  // Optional so a pre-captions snapshot still reads.
  words?: Word[];
  captionsEnabled?: boolean;
  captionStyle?: CaptionStyle;
  captionBlocks?: CaptionBlock[];
  // Timeline snapping preference + ruler markers. Optional so an older snapshot
  // (pre-markers) still reads and falls back to the store defaults.
  snapEnabled?: boolean;
  markers?: Marker[];
  // Explicitly-deleted raw word indices (the word-delete authority). Optional so a
  // pre-word-delete snapshot still reads and restores an empty set.
  deletedWordIndices?: number[];
  // Free-floating media overlays (a SEPARATE top-level concept, never Clips). `src`
  // is a stable proxied /api/... path after copy-to-disk import; a leftover blob: src
  // is dead after reload and flags a reconnect. Optional for a pre-overlay snapshot.
  overlays?: Overlay[];
  // The generated sound-effects track. `src` is a proxied /api/repurpose/sfx path;
  // on restore it is RE-DERIVED fresh from `sourcePath`. Optional for pre-SFX.
  sfxTrack?: SfxTrack | null;
  // The manually-added background-music track. `src` is a proxied
  // /api/repurpose/asset path; RE-DERIVED from `sourcePath` on restore. Optional.
  musicTrack?: MusicTrack | null;
  // The media bin (Files-panel asset library). Each `src` is a proxied /api/repurpose
  // path, RE-DERIVED from `sourcePath` on restore. Optional for a pre-media-bin snapshot.
  mediaAssets?: MediaAsset[];
}
