// ===========================================================================
// REPURPOSE STUDIO -- FCPXML import (NEW, additive path)
// ===========================================================================
// Turns a Descript-exported FCPXML (the FINAL edit) into the same Clip[] +
// FootageMeta the store already consumes -- WITHOUT the take-matcher. The
// fcpxml already contains the cut decisions (each top-level spine
// <asset-clip> is one surviving window) and the final transcript (its
// <caption> children), so there is nothing to "guess": we read the cuts.
//
// This module is PURE (no React, no store, no fs, no child_process, no
// ffprobe) so it runs in the browser and in a Node script alike. It does NOT
// import or modify any existing ingest flow -- the old two-SRT path
// (buildShortClips/matchTakes) stays untouched as the fallback.
//
// SOURCE OF TRUTH: scripts/repurpose-fcpxml.mjs. This lib must mirror that
// script's hardened behavior EXACTLY (minus the fs/ffprobe/HTTP the script
// owns): the DEPTH-TRACKED spine walk (indentation-independent), self-closing
// caption support, the FACE-CAM SOURCE-seconds word emission, and the sliver
// rules (drop < 0.2s, merge <= 0.4s source gap). See the story-print script
// that validated the two-clock timing math against Manthan's srt.
//
// TWO-CLOCK MODEL (the whole trick):
//   Each top-level spine <asset-clip ref="r2"> (the face-cam take) carries:
//     - start:    the RAW in-point (seconds into the raw face-cam file)
//     - offset:   where the clip lands on the OUTPUT timeline
//     - duration: the clip length
//   Each <caption> child carries an `offset` on the RAW clock. Its OUTPUT time is
//     outStart = caption.offset - clip.start + clip.offset
//   and its SOURCE time (raw face-cam seconds) is
//     srcStart = clip.srcStart + (caption.offset - clip.start)  (== caption.offset)
//   i.e. how far the caption sits INTO the clip (raw), placed at the clip's
//   output slot. Verified: parser total 08:34.87 == srt 08:34,886.
// ===========================================================================

import type { Clip, OverlayTransform, Word } from "./types";

/** One surviving cut read straight from the fcpxml spine. */
export interface FcpClip {
  /** RAW in-point in the FACE-CAM file (seconds). Maps to Clip.srcStart. */
  srcStart: number;
  /** RAW out-point in the FACE-CAM file (seconds). Maps to Clip.srcEnd. */
  srcEnd: number;
  /** Where this clip lands on the OUTPUT timeline (seconds). */
  outStart: number;
  /** Output out-point (outStart + duration). */
  outEnd: number;
  /** The final transcript text spanning this clip (its captions joined). */
  text: string;
}

/**
 * One caption line on the timeline. Carries BOTH clocks (mirrors the script,
 * which emits words in FACE-CAM SOURCE seconds): `outStart`/`outEnd` on the
 * OUTPUT clock and `srcStart`/`srcEnd` on the raw FACE-CAM clock.
 */
export interface FcpCaptionLine {
  outStart: number;
  outEnd: number;
  /** RAW in-point in the FACE-CAM file (seconds) -- the SOURCE clock. */
  srcStart: number;
  /** RAW out-point in the FACE-CAM file (seconds). */
  srcEnd: number;
  text: string;
}

/** The video/audio asset filenames the fcpxml references, by resource id. */
export interface FcpAsset {
  id: string;
  /** Decoded src filename (e.g. "Lead Gen Man.mp4"). */
  src: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

/**
 * One raw video/image overlay (B-roll / screen-insert / logo) parsed from a
 * nested asset-clip, on the OUTPUT clock. Mirrors an entry of the script's
 * `overlaysRaw[]`. Re-anchored into a built short by buildOverlaysFromFcp().
 */
export interface FcpOverlay {
  /** Decoded overlay asset filename (from the asset's src). */
  assetSrc: string;
  kind: "video" | "image";
  /** OUTPUT-timeline in-point (the nested clip's offset). */
  outStart: number;
  /** OUTPUT-timeline out-point (outStart + duration). */
  outEnd: number;
  /** The overlay's OWN source in-point (the nested clip's start). */
  srcStart: number;
  /** Overlay length (the nested clip's duration). */
  durSec: number;
  /** Optional adjust-transform (FCPXML normalized position/scale), if present. */
  transform?: { px?: number; py?: number; scale?: number };
}

/** Everything the importer extracts from one fcpxml. */
export interface FcpParseResult {
  /** Resource-id -> asset (r2 = face, r4 = screen, etc.). */
  assets: Record<string, FcpAsset>;
  /** Resolved face-cam asset (the ref="r2" spine clips point at), if found. */
  faceAsset?: FcpAsset;
  /** Resolved screen asset (the nested ref child), if found. */
  screenAsset?: FcpAsset;
  /** Every surviving cut, in output order. */
  clips: FcpClip[];
  /** Every caption line on the output timeline, in output order. */
  captions: FcpCaptionLine[];
  /** Every nested video/image overlay (B-roll), on the OUTPUT clock. */
  overlays: FcpOverlay[];
  /** Total output duration (seconds), from the <sequence duration>. */
  durationSec: number;
  /** Output fps, from the format frameDuration (default 30). */
  fps: number;
  /**
   * Nested asset-clip srcs with an UNRECOGNIZED extension (not face/screen, NOT
   * audio-by-ext, and overlayKindOf() returned null), deduped. Mirrors the
   * script's `unknownOverlayExts` -- so a NEW video/image ext type is SURFACED
   * (caller can flag it), never silently swallowed. Audio is a DELIBERATE skip
   * and is NEVER collected here.
   */
  unknownExts: string[];
}

// --- rational "N/Ms" or "Ns" -> seconds ------------------------------------
function toSeconds(v: string | undefined): number {
  if (v == null) return 0;
  const s = v.trim();
  const m = s.match(/^(-?\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?s$/);
  if (!m) return Number(s) || 0;
  const num = Number(m[1]);
  const den = m[2] ? Number(m[2]) : 1;
  return den === 0 ? 0 : num / den;
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}

/** Decode the %20-encoded `src` of an fcpxml asset into a plain filename. */
function decodeSrc(raw: string | undefined): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Decode XML entities in caption TEXT (Descript escapes &, <, >, ', " in speech).
const XML_ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unent(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_ENT[e] ?? whole;
  });
}
// Common lead-in words that look like a "Speaker:" label but are real speech.
const LEADIN = /^(Note|Tip|Warning|Example|Reminder|Hint|Caution|FYI|PS|NB|Pro tip|Step \d+|Q|A):/i;
/**
 * Clean caption text, mirroring scripts/repurpose-fcpxml.mjs EXACTLY:
 * strip REAL markup first (while <...> are literal), THEN decode entities (so a
 * decoded "&lt;10x" is not re-eaten as a tag), THEN drop a leading speaker label
 * WITHOUT eating URLs ("https://"), times ("3:30"), or lead-ins ("Note:").
 * Descript speaker labels are the full name (>=2 Title-Case words).
 */
function cleanCaptionText(text: string): string {
  const stripped = unent(text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  if (LEADIN.test(stripped)) return stripped.trim();
  return stripped.replace(/^([A-Z][\w.'-]*(?:\s[A-Z][\w.'-]*){1,3}):\s(?!\/\/)/, "").trim();
}

// --- video-overlay support, mirrors scripts/repurpose-fcpxml.mjs
// A nested asset-clip inside a face clip whose asset is a real VIDEO or IMAGE
// file (B-roll / screen-insert / logo) is carried into the built short.
// AUDIO-by-extension is skipped even when hasVideo="1" (Descript marks
// .wav/.mp3 with hasVideo in some exports -- the ext is the truth).
const AUDIO_EXT = new Set([".wav", ".mp3", ".m4a", ".aac", ".aiff", ".aif", ".flac", ".ogg", ".opus"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"]);

/** Lowercased file extension incl. the dot (e.g. ".mp4"), or "" if none. */
function extOf(src: string): string {
  const dot = src.lastIndexOf(".");
  return dot < 0 ? "" : src.slice(dot).toLowerCase();
}

/**
 * Classify a nested overlay asset by its filename extension. Returns "video" /
 * "image" or null (audio ext, or unknown ext -> not an overlay). Byte-identical
 * to overlayKindOf() in scripts/repurpose-fcpxml.mjs.
 */
function overlayKindOf(src: string): "video" | "image" | null {
  if (!src) return null;
  const ext = extOf(src);
  if (AUDIO_EXT.has(ext)) return null;      // audio lane, never an overlay
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  return null;                              // unknown ext -> not an overlay
}

/**
 * Best-effort parse of a nested <adjust-transform position="X Y" scale="SX SY"/>
 * from a nested clip body. Returns {px,py,scale} in FCPXML's normalized space or
 * null if absent (caller defaults to centered full-frame). Mirrors the script's
 * parseAdjustTransform().
 */
function parseAdjustTransform(body: string): { px?: number; py?: number; scale?: number } | null {
  const m = body && body.match(/<adjust-transform\b([^>]*?)\/?>/);
  if (!m) return null;
  const pos = attr(m[1], "position");
  const scl = attr(m[1], "scale");
  const [px, py] = (pos ? pos.trim().split(/\s+/) : []).map(Number);
  const [sx] = (scl ? scl.trim().split(/\s+/) : []).map(Number);
  return {
    px: Number.isFinite(px) ? px : undefined,
    py: Number.isFinite(py) ? py : undefined,
    scale: Number.isFinite(sx) ? sx : undefined,
  };
}

/**
 * Parse a Descript FCPXML string into cuts + captions + assets. Pure string
 * work (no XML lib) so it is dependency-free and node-canvas/SSR safe.
 *
 * The spine walk is DEPTH-TRACKED (counts asset-clip open / self-close / close
 * tags), so it never depends on Descript's exact indentation -- ported straight
 * from scripts/repurpose-fcpxml.mjs.
 */
export function parseFcpxml(xml: string): FcpParseResult {
  // --- resources: map every <asset> and pick the output fps from a <format> --
  const assets: Record<string, FcpAsset> = {};
  // NB: `\basset\b` would also match `<asset-clip>` (hyphen is a word boundary),
  // polluting the map with junk ids. Require whitespace after `asset` so only
  // real `<asset ...>` resource tags match, never `<asset-clip>`.
  const assetRe = /<asset\s([^>]*?)\/?>/g;
  let am: RegExpExecArray | null;
  while ((am = assetRe.exec(xml)) !== null) {
    const t = am[1];
    const id = attr(t, "id");
    if (!id) continue;
    assets[id] = {
      id,
      src: decodeSrc(attr(t, "src")),
      hasVideo: attr(t, "hasVideo") === "1",
      hasAudio: attr(t, "hasAudio") === "1",
    };
  }

  // Output fps from the first real <format> with a frameDuration (e.g. 1/30s).
  let fps = 30;
  const fmt = xml.match(/<format\b[^>]*\bframeDuration="([^"]*)"[^>]*>/);
  if (fmt) {
    const fd = toSeconds(fmt[1]);
    if (fd > 0) fps = Math.round(1 / fd);
  }

  // Sequence (output) duration.
  const seq = xml.match(/<sequence\b[^>]*\bduration="([^"]*)"/);
  const durationSec = seq ? toSeconds(seq[1]) : 0;

  // --- spine walk: DEPTH-TRACKED top-level asset-clips -----------------------
  // Slice the spine BODY (between <spine> and </spine>), then tokenize
  // asset-clip open / self-close / close tags and captions. A top-level clip is
  // one opened at depth 0. Indentation-independent (no hardcoded 12-space rule).
  const spineStart = xml.indexOf("<spine>");
  const spineEnd = xml.indexOf("</spine>");
  const spine =
    spineStart >= 0 && spineEnd >= 0
      ? xml.slice(spineStart + "<spine>".length, spineEnd)
      : xml;

  const clips: FcpClip[] = [];
  const captions: FcpCaptionLine[] = [];
  const overlays: FcpOverlay[] = []; // nested video/image overlays (B-roll), OUTPUT clock
  // Nested asset-clip srcs with an UNRECOGNIZED ext (not face/screen, NOT
  // audio-by-ext, overlayKindOf() === null). Deduped -> returned as unknownExts.
  // Mirrors the script's `unknownOverlayExts` Set. Audio is a deliberate skip.
  const unknownExtsSet = new Set<string>();

  // One token = an asset-clip open (with a self-close flag), an asset-clip
  // close, or a caption (self-closing OR with a nested body). Mirrors the
  // script's `tokRe` exactly.
  const tokRe =
    /<asset-clip\b([^>]*?)(\/?)>|<\/asset-clip>|<caption\b([^>]*?)(?:\/>|>([\s\S]*?)<\/caption>)/g;

  let depth = 0;
  // The current top-level clip being filled (its raw + output windows), or null
  // when we are between top-level clips. Captions attach to it while depth >= 1.
  let cur:
    | {
        srcStart: number;
        outStart: number;
        ref?: string;
        lines: FcpCaptionLine[];
      }
    | null = null;
  let faceRef: string | undefined;
  let screenRef: string | undefined;

  let tm: RegExpExecArray | null;
  while ((tm = tokRe.exec(spine)) !== null) {
    const tok = tm[0];
    if (tok.startsWith("<asset-clip")) {
      const attrs = tm[1];
      const selfClose = tm[2] === "/";
      if (depth === 0) {
        const start = toSeconds(attr(attrs, "start"));
        const offset = toSeconds(attr(attrs, "offset"));
        const dur = toSeconds(attr(attrs, "duration"));
        const ref = attr(attrs, "ref");
        // Face cam must be a VIDEO asset (a clip may lead with an audio-only ref).
        if (ref && !faceRef && assets[ref]?.hasVideo) faceRef = ref;
        const lines: FcpCaptionLine[] = [];
        cur = { srcStart: start, outStart: offset, ref, lines };
        clips.push({
          srcStart: start,
          srcEnd: start + dur,
          outStart: offset,
          outEnd: offset + dur,
          // Filled once the clip's captions are collected (below).
          text: "",
        });
        if (!selfClose) depth = 1;
      } else {
        // Nested clip (e.g. the screen lane). Capture the first distinct video ref.
        const nref = attr(attrs, "ref");
        if (!screenRef && nref && nref !== cur?.ref && assets[nref]?.hasVideo) {
          screenRef = nref;
        }
        // Video/image OVERLAY: a nested asset-clip whose asset is
        // NOT the face and NOT the screen, is a real video/image by EXTENSION
        // (audio skipped even if hasVideo), and lives directly inside a top-level
        // face clip. Refs are tested against the refs resolved SO FAR (mirrors
        // the script's nref !== faceRef && nref !== screenRef).
        if (cur && nref && nref !== faceRef && nref !== screenRef) {
          const nsrc = assets[nref]?.src ?? "";
          const kind = overlayKindOf(nsrc);
          // Truly-unknown ext (NOT audio, NOT a known video/image) -> record so
          // the caller can surface it, never a silent skip. Audio-by-ext is a
          // deliberate skip and is NOT collected (mirrors the script).
          if (!kind && nsrc && !AUDIO_EXT.has(extOf(nsrc))) {
            unknownExtsSet.add(nsrc);
          }
          if (kind) {
            // offset = parent's RAW clock (same clock a <caption>'s offset uses,
            // NOT the output clock); start = overlay's OWN source in-point;
            // duration = overlay length. Grab the nested body (if not self-closing)
            // to read an optional adjust-transform.
            const oStart = toSeconds(attr(attrs, "start"));   // overlay-own clock
            const oOffRaw = toSeconds(attr(attrs, "offset")); // parent RAW clock
            const oDur = toSeconds(attr(attrs, "duration"));
            // Two-clock map to OUTPUT, IDENTICAL to the caption branch (line ~391):
            // outStart = cur.outStart + (oOffRaw - cur.srcStart). cur is the
            // enclosing top-level face clip (non-null inside depth >= 1).
            const oOut = cur.outStart + (oOffRaw - cur.srcStart);
            let xform: { px?: number; py?: number; scale?: number } | null = null;
            if (!selfClose) {
              const bodyStart = tokRe.lastIndex;
              const close = spine.indexOf("</asset-clip>", bodyStart);
              const nextOpen = spine.indexOf("<asset-clip", bodyStart);
              const bodyEnd =
                close < 0
                  ? spine.length
                  : nextOpen >= 0 && nextOpen < close
                    ? nextOpen
                    : close;
              xform = parseAdjustTransform(spine.slice(bodyStart, bodyEnd));
            }
            overlays.push({
              assetSrc: assets[nref]?.src ?? "",
              kind,
              outStart: oOut,
              outEnd: oOut + oDur,
              srcStart: oStart,
              durSec: oDur,
              ...(xform ? { transform: xform } : {}),
            });
          }
        }
        if (!selfClose) depth++;
      }
    } else if (tok === "</asset-clip>") {
      if (depth > 0) depth--;
      if (depth === 0) {
        // Close out the current top-level clip: join its caption text.
        if (cur) {
          const clip = clips[clips.length - 1];
          if (clip) {
            clip.text = cur.lines
              .map((l) => l.text)
              .filter(Boolean)
              .join(" ");
          }
        }
        cur = null;
      }
    } else if (tok.startsWith("<caption")) {
      // A caption belongs to the current top-level clip (Descript nests them at
      // the DIRECT child level). depth===1 avoids attributing a deep-lane caption
      // here. Supports self-closing captions AND captions with a nested body.
      if (cur && depth === 1) {
        const cAttrs = tm[3] || "";
        const body = tm[4] || "";
        const capOffset = toSeconds(attr(cAttrs, "offset"));
        const capDur = toSeconds(attr(cAttrs, "duration"));
        const tsMatch = body.match(
          /<text-style\b[^>]*>([\s\S]*?)<\/text-style>/,
        );
        const text = cleanCaptionText(tsMatch ? tsMatch[1] : body);
        // OUTPUT clock: how far the caption sits into the clip, at its slot.
        const outStart = capOffset - cur.srcStart + cur.outStart;
        // SOURCE clock (raw face-cam seconds): cur.srcStart + (capOffset -
        // cur.srcStart) == capOffset, kept explicit to match the script.
        const srcStart = cur.srcStart + (capOffset - cur.srcStart);
        const line: FcpCaptionLine = {
          outStart,
          outEnd: outStart + capDur,
          srcStart,
          srcEnd: srcStart + capDur,
          text,
        };
        cur.lines.push(line);
        if (text) captions.push(line);
      }
    }
  }

  captions.sort((a, b) => a.outStart - b.outStart);

  return {
    assets,
    faceAsset: faceRef ? assets[faceRef] : undefined,
    screenAsset: screenRef ? assets[screenRef] : undefined,
    clips,
    captions,
    overlays,
    durationSec,
    fps,
    unknownExts: [...unknownExtsSet],
  };
}

// ---------------------------------------------------------------------------
// A "short spec" = a selection of OUTPUT-timeline windows (the lines we picked
// for a given short). Each window is [outStart, outEnd] in the fcpxml's output
// clock. buildShortFromFcp resolves those against the parsed clips and emits
// the exact Clip[] the store expects -- src windows in FACE-CAM raw seconds.
// ---------------------------------------------------------------------------

export interface FcpShortWindow {
  /** Output-timeline start of a picked line (seconds), matching a caption/clip. */
  outStart: number;
  /** Output-timeline end of the picked line (seconds). */
  outEnd: number;
  /** Optional label (the line text) for the clip. */
  text?: string;
}

/**
 * The per-cut "Smart transition", duplicated here so this module never imports
 * the old ingest flow. DESCRIPT-FEEL: a SUBTLE settle, never a pop. `amount:
 * 0.025` -> the incoming clip starts 2.5% larger and eases to normal (compositor
 * boost = 1 + amount*(1-e)), giving every real cut a gentle "landed" motion even
 * when framing matches -- the smooth, natural feel of Descript's Smart
 * Transition, far below a zoom "pop". ~0.4s natural matches Descript's soft
 * window. Applied ONLY to real source jumps (see CUT_GAP below), never to a
 * continuous same-take join the spine split at a caption boundary.
 */
const SMART_TRANSITION = {
  type: "zoom-settle" as const,
  durationSec: 0.4,
  amount: 0.025,
  easing: "natural" as const,
};

/**
 * Only a REAL source jump earns a transition. Two clips whose source is
 * continuous (gap <= this many seconds) are the SAME take the spine split at a
 * caption boundary; joining them with a transition is a forced pop. Mirrors the
 * script's CUT_GAP.
 */
const CUT_GAP = 0.4;

// Sliver rules, ported verbatim from scripts/repurpose-fcpxml.mjs:
//  - MERGE: adjacent same-clip source ranges within this gap (seconds) join.
//  - MIN:   a source range shorter than this (seconds) is a boundary sliver,
//           dropped.
const MERGE_GAP = 0.4;
const MIN_RANGE = 0.2;

/**
 * Map an OUTPUT-timeline window back to a FACE-CAM SOURCE window using the spine
 * clips. For a window fully inside one clip: srcStart = clip.srcStart +
 * (win.outStart - clip.outStart). Windows are expected to align to caption/clip
 * boundaries (the short-picker uses exact caption times), so this covers the
 * common case; a window spanning a cut is split at the boundary.
 */
export function windowToSourceRanges(
  clips: FcpClip[],
  win: FcpShortWindow,
): { srcStart: number; srcEnd: number }[] {
  const EPS = 1e-3;
  const out: { srcStart: number; srcEnd: number }[] = [];
  for (const c of clips) {
    const lo = Math.max(win.outStart, c.outStart);
    const hi = Math.min(win.outEnd, c.outEnd);
    if (hi - lo <= EPS) continue;
    const srcStart = c.srcStart + (lo - c.outStart);
    const srcEnd = c.srcStart + (hi - c.outStart);
    out.push({ srcStart, srcEnd });
  }
  return out;
}

/**
 * Build the store's Clip[] for a short from a set of picked output-timeline
 * windows. Mirrors the script's build step: each picked window is resolved to
 * its FACE-CAM SOURCE range, contiguous same-clip ranges within MERGE_GAP
 * (0.4s) are joined (their text concatenated), and any range below MIN_RANGE
 * (0.2s) is dropped as a boundary sliver. timelineStart/End are seeded at 0 (the
 * store's recomputeTimeline lays them out back-to-back), exactly like
 * shortClipsToClips in the old flow -- so downstream is byte-identical.
 */
export function buildShortFromFcp(
  clips: FcpClip[],
  windows: FcpShortWindow[],
): Clip[] {
  const EPS = 1e-3;
  // Flatten every window to source ranges, in the windows' given order, merging
  // contiguous same-clip ranges whose source gap is within MERGE_GAP.
  const ranges: { srcStart: number; srcEnd: number; text: string }[] = [];
  for (const w of windows) {
    for (const r of windowToSourceRanges(clips, w)) {
      const last = ranges[ranges.length - 1];
      // Merge forward-adjacent ranges (script: gap <= MERGE and not going
      // backwards past the current range start).
      if (
        last &&
        r.srcStart - last.srcEnd <= MERGE_GAP &&
        r.srcStart >= last.srcStart - EPS
      ) {
        last.srcEnd = Math.max(last.srcEnd, r.srcEnd);
        const t = (w.text ?? "").trim();
        last.text = last.text ? (t ? `${last.text} ${t}` : last.text) : t;
      } else {
        ranges.push({
          srcStart: r.srcStart,
          srcEnd: r.srcEnd,
          text: (w.text ?? "").trim(),
        });
      }
    }
  }

  // Drop sub-threshold slivers (script: MIN).
  const kept = ranges.filter((r) => r.srcEnd - r.srcStart >= MIN_RANGE);

  return kept.map((r, i) => {
    // Transition ONLY on a real source jump. A continuous same-take join (the
    // previous kept range ends within CUT_GAP of this one's start) gets NO
    // transition -- that continuous speech should read as one uninterrupted
    // shot, never a pop. Mirrors the script's transitionFor().
    const prevSrcEnd = i > 0 ? kept[i - 1].srcEnd : null;
    // +1e-6 absorbs float error so a gap of exactly CUT_GAP counts as continuous.
    const isRealCut = i > 0 && prevSrcEnd != null && r.srcStart - prevSrcEnd > CUT_GAP + 1e-6;
    return {
      id: `fcp-${i}`,
      kind: "take" as const,
      label: r.text,
      srcStart: r.srcStart,
      srcEnd: r.srcEnd,
      timelineStart: 0,
      timelineEnd: 0,
      kept: true,
      isKeeperTake: false,
      occurrences: [{ start: r.srcStart, end: r.srcEnd }],
      keeperIndex: 0,
      transitionIn: isRealCut ? SMART_TRANSITION : undefined,
      originId: `fcp-${i}`,
    };
  });
}

/**
 * Derive per-word timings (for captions) from the fcpxml caption lines. Each
 * caption line is spread word-by-word across its FACE-CAM SOURCE window (matching
 * the script, whose WordTranscript panel classifies in-short vs outside by
 * testing word.start against clip.srcStart..srcEnd on the SOURCE clock). Words
 * come out sorted by source start.
 */
export function captionsToWords(captions: FcpCaptionLine[]): Word[] {
  const words: Word[] = [];
  for (const line of captions) {
    const toks = line.text.split(/\s+/).filter(Boolean);
    if (toks.length === 0) continue;
    const span = Math.max(0.001, line.srcEnd - line.srcStart);
    const per = span / toks.length;
    toks.forEach((t, i) => {
      const start = line.srcStart + i * per;
      words.push({ text: t, start, end: start + per });
    });
  }
  words.sort((a, b) => a.start - b.start);
  return words;
}

// ---------------------------------------------------------------------------
// Overlay re-anchor: map the parsed FCPXML overlays (OUTPUT clock)
// into a built short's NEW timeline. PURE -- no ffprobe/fs/proxy; the caller
// supplies natural w/h + intrinsic duration via `probe`, and resolves
// src/sourcePath/id/zIndex from `assetSrc` after. Mirrors the script's build
// re-anchor block line for line.
// ---------------------------------------------------------------------------

/** Drop overlay-range intersections shorter than this (seconds). */
const OVL_MIN = 0.2;

/** What the caller's probe returns for one overlay asset. */
export interface FcpOverlayProbe {
  naturalWidth: number;
  naturalHeight: number;
  srcDuration: number;
}

/**
 * A store-`Overlay` minus id/zIndex/src/sourcePath (which the caller fills,
 * since the id scheme + proxy URLs are caller-owned). Carries `assetSrc` so the
 * caller can resolve the real src/sourcePath.
 */
export interface BuiltOverlay {
  kind: "video" | "image";
  naturalWidth: number;
  naturalHeight: number;
  timelineStart: number;
  timelineEnd: number;
  srcStart: number;
  srcDuration: number;
  transform: OverlayTransform;
  opacity: number;
  muted?: true;
  /** Split-screen clip band. "screen" = cover the top panel, clipped. */
  band?: "screen" | "face" | "free";
  /** So the caller can resolve src/sourcePath (id/zIndex are caller-owned). */
  assetSrc: string;
}

/**
 * The fate of one RAW overlay after re-anchor, mirroring the script's
 * per-overlay audit so an in-app import can surface silently-dropped overlays.
 *   carried  -> >=1 face-source intersection >= OVL_MIN survived + pushed
 *   cut      -> covered a top-level clip, but no kept-range intersection reached
 *               OVL_MIN (legit: those words are not in this short)
 *   unmapped -> covered NO top-level clip (BUG-CLASS: offset/two-clock mismatch)
 * NOTE: there is deliberately NO "missing" fate here. The script's "missingfile"
 * is an fs check (probe width 0 / durationSec 0 AND file absent on disk) that
 * this PURE lib cannot do. The caller LAYERS that on top using the probe() result
 * (naturalWidth === 0 / srcDuration === 0) plus its own file-existence check.
 */
export interface OverlayFate {
  assetSrc: string;
  kind: "video" | "image";
  outStart: number;
  outEnd: number;
  fate: "carried" | "cut" | "unmapped";
}

/**
 * Result of buildOverlaysFromFcp: the carried overlays (byte-identical to the
 * prior BuiltOverlay[] return) PLUS a per-raw-overlay `audit` so the caller can
 * detect drops (cut / unmapped) and warn.
 */
export interface OverlayReanchorResult {
  /** Carried overlays, sorted by timelineStart (id/zIndex still caller-owned). */
  overlays: BuiltOverlay[];
  /** One entry per RAW input overlay, in input order, with its computed fate. */
  audit: OverlayFate[];
}

/**
 * Re-anchor parsed FCPXML overlays into a built short. Each raw overlay lives on
 * the OUTPUT clock; map its OUTPUT window to the FACE-CAM SOURCE clock with the
 * SAME two-clock the lines use (via the top-level `clips`), then intersect with
 * each kept picked range's SOURCE window and place the surviving pieces onto the
 * NEW timeline. Returns { overlays, audit }: `overlays` (sorted by timelineStart,
 * id/zIndex NOT assigned here -- caller numbers them) is byte-identical to the
 * prior return; `audit` classifies each raw overlay carried/cut/unmapped so a
 * silent loss is impossible. EXACT port of the script's re-anchor + audit.
 *
 * @param overlaysRaw       FcpParseResult.overlays (OUTPUT clock).
 * @param clips             FcpParseResult.clips (top-level face cuts).
 * @param keptRanges        The build's kept SOURCE windows (post merge + sliver).
 * @param keptTimelineStarts outClips[i].timelineStart, index-aligned to keptRanges.
 * @param probe             Caller supplies natural w/h + intrinsic duration per assetSrc.
 */
export function buildOverlaysFromFcp(
  overlaysRaw: FcpOverlay[],
  clips: FcpClip[],
  keptRanges: { srcStart: number; srcEnd: number }[],
  keptTimelineStarts: number[],
  probe: (assetSrc: string) => FcpOverlayProbe,
): OverlayReanchorResult {
  const overlays: BuiltOverlay[] = [];
  const audit: OverlayFate[] = [];
  for (const ov of overlaysRaw) {
    let covered = false;  // any top-level clip covers this overlay
    let survived = false; // any intersection >= OVL_MIN was pushed
    // OUTPUT window -> FACE SOURCE window via the covering top-level clip(s).
    for (const clip of clips) {
      const covStart = Math.max(ov.outStart, clip.outStart);
      const covEnd = Math.min(ov.outEnd, clip.outEnd);
      if (covEnd - covStart <= 0) continue;                 // this clip doesn't cover it
      covered = true;
      const ovSrcStart = clip.srcStart + (covStart - clip.outStart);
      const ovSrcEnd = clip.srcStart + (covEnd - clip.outStart);
      // face-source in-point of the overlay's OWN media at ovSrcStart:
      const ovOwnAtSrcStart = ov.srcStart + (covStart - ov.outStart);
      // Intersect the face-source overlay window with each kept picked range.
      for (let i = 0; i < keptRanges.length; i++) {
        const r = keptRanges[i];
        const iS = Math.max(ovSrcStart, r.srcStart);
        const iE = Math.min(ovSrcEnd, r.srcEnd);
        if (iE - iS < OVL_MIN) continue;
        survived = true;
        const tlStart = keptTimelineStarts[i] + (iS - r.srcStart);
        const tlEnd = keptTimelineStarts[i] + (iE - r.srcStart);
        const newSrcStart = ovOwnAtSrcStart + (iS - ovSrcStart);
        const pm = probe(ov.assetSrc);
        // DEFAULT: COVER the SCREEN (top) band, clipped to it -- fills the
        // screen-recording panel edge-to-edge (crop overflow), never onto the face
        // cam. splitRatio 0.5 for these builds; cover scale (fraction of output
        // width) = max(1, (SPLIT / OUT_RATIO) * (natW/natH)), OUT_RATIO = 1080/1920,
        // centered in the top band (x 0.5, y SPLIT/2). Honor an explicit FCPXML
        // <adjust-transform> if present (user positioned it in Descript); else cover.
        const t = ov.transform ?? {};
        const SPLIT = 0.5;
        const OUT_RATIO = 1080 / 1920;
        let tx: number;
        let ty: number;
        let scale: number;
        if (t.px != null || t.py != null || t.scale != null) {
          tx = t.px != null ? 0.5 + t.px / 2 : 0.5;
          ty = t.py != null ? 0.5 - t.py / 2 : SPLIT / 2;
          scale = t.scale != null ? t.scale : 1;
        } else {
          const natW = pm.naturalWidth > 0 ? pm.naturalWidth : 1;
          const natH = pm.naturalHeight > 0 ? pm.naturalHeight : 1;
          scale = Math.max(1, (SPLIT / OUT_RATIO) * (natW / natH));
          tx = 0.5;
          ty = SPLIT / 2;
        }
        overlays.push({
          kind: ov.kind,
          naturalWidth: pm.naturalWidth,
          naturalHeight: pm.naturalHeight,
          timelineStart: tlStart,
          timelineEnd: tlEnd,
          srcStart: newSrcStart,
          srcDuration: pm.srcDuration || ov.durSec,
          transform: { x: tx, y: ty, scale, rotation: 0 },
          band: "screen",
          opacity: 1,
          ...(ov.kind === "video" ? { muted: true as const } : {}),
          assetSrc: ov.assetSrc,
        });
      }
    }
    // Classify this raw overlay's fate (NO "missing" -- that is an fs check the
    // caller layers on via probe() width/duration === 0 + file existence).
    const fate: OverlayFate["fate"] = survived
      ? "carried"
      : covered
        ? "cut"
        : "unmapped";
    audit.push({
      assetSrc: ov.assetSrc,
      kind: ov.kind,
      outStart: ov.outStart,
      outEnd: ov.outEnd,
      fate,
    });
  }
  // Sorted by timelineStart (caller assigns id/zIndex in this order).
  overlays.sort((a, b) => a.timelineStart - b.timelineStart);
  return { overlays, audit };
}
