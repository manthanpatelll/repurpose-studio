"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TrashSimple, ArrowCounterClockwise, Star } from "@phosphor-icons/react";
import type { Clip, Word } from "@/lib/repurpose/types";
import { formatTimecode } from "./timeline-utils";
import { sliceClipPeaks, type FaceWaveform } from "./useFaceWaveform";

interface ClipBlockProps {
  clip: Clip;
  left: number;
  width: number;
  trackTop: number;
  trackHeight: number;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDragBodyStart: (clip: Clip, pointerX: number) => void;
  onDragEdgeStart: (clip: Clip, edge: "start" | "end", pointerX: number) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  /**
   * Whole-source face-cam peaks, shared by every clip (see useFaceWaveform).
   * null while decoding / when there is no decodable audio -- in which case
   * the clip renders with NO waveform, exactly as before. Only kept `take`
   * clips draw it; silence + ghost clips never do.
   */
  waveform?: FaceWaveform | null;
  /**
   * The whole raw transcript (store.words), in SOURCE seconds. A kept take clip
   * draws a faint vertical divider at every word boundary inside its
   * [srcStart, srcEnd) window, so Manthan can see exactly which word he's on at
   * a given spot on the clip -- the timeline twin of the transcript's per-word
   * cells. Empty/absent -> no dividers (exactly as before).
   */
  words?: Word[];
  /**
   * Click a WORD CELL inside this clip (when the word grid is readable) -> select
   * just that word, not the whole scene. Receives the word's RAW index (into
   * store.words) so the caller can seek + selectWords + route a Delete to the
   * word. Absent -> cells are non-interactive (a body click selects the scene as
   * before).
   */
  onWordCellClick?: (rawWordIndex: number) => void;
  /**
   * Double-click a WORD CELL inside this clip (when the word grid is readable) ->
   * commit new caption text for that word, mirroring the transcript's
   * double-click-to-edit. ClipBlock owns the inline <input> + draft state (so
   * Timeline stays simple); this is called on commit with the word's RAW index
   * (into store.words) and the new text, which the caller routes to the store's
   * editWordText. Absent -> a double-click on a cell is inert, as before.
   */
  onWordCellDoubleClick?: (rawWordIndex: number, newText: string) => void;
  /**
   * Select a RANGE of words by DRAGGING across cells, or by SHIFT+CLICKing to
   * extend from the current selection (Descript parity). Receives the anchor and
   * focus RAW indices (into store.words) in swept order; the caller normalizes
   * lo/hi via the store's selectWords. Absent -> only single-word clicks work,
   * and a body drag falls back to moving the clip.
   */
  onWordRangeSelect?: (fromRawIndex: number, toRawIndex: number) => void;
  /** The raw index of the currently shared-selected word, for cell highlight. */
  selectedWordIndex?: number | null;
  /**
   * The full shared word selection [lo, hi] (inclusive raw indices), so a
   * multi-word RANGE washes EVERY cell it spans -- not just its endpoints. When
   * lo===hi this is the same single word as selectedWordIndex. Absent/null ->
   * the range wash is skipped (the single selectedWordIndex highlight still runs).
   */
  selectedWordRange?: { lo: number; hi: number } | null;
  /**
   * The raw index of the word currently UNDER THE PLAYHEAD (Descript's karaoke
   * word). Highlighted distinctly from the selected word so "now playing" reads
   * apart from "selected", and it moves cell-to-cell during playback.
   */
  playheadWordIndex?: number | null;
}

// Word-divider ink -- fainter than the scene-cut lines so it reads as a
// within-clip subdivision, never competes with the clip's own boundaries.
const WORD_DIVIDER_COLOR = "rgba(226, 232, 240, 0.16)";
// Word text ink inside a cell (only drawn once a cell is wide enough to fit it).
const WORD_TEXT_COLOR = "rgba(226, 232, 240, 0.82)";
// Below this clip width a word grid would be an unreadable smear, so we skip it.
const MIN_CLIP_PX_FOR_WORDS = 24;
// Skip drawing sub-word gridlines closer than this many CSS px -- keeps a fast
// passage from turning into a solid block of lines.
const MIN_WORD_GAP_PX = 5;
// A cell must be at least this wide (CSS px) before we try to draw its word
// text; below this it stays a bare tick (label wouldn't fit legibly).
const MIN_CELL_PX_FOR_TEXT = 22;
// Cell font size (CSS px). Matches the clip label's small scale.
const WORD_FONT_PX = 10;

/**
 * Per-word CELL grid drawn inside a kept take clip: each word that falls within
 * the clip's [srcStart, srcEnd) source window becomes a cell bounded by its own
 * start/end (mapped to clip-local pixels), and once a cell is wide enough the
 * WORD ITSELF is drawn inside it -- so zooming in reveals which word sits where,
 * the timeline twin of the transcript's word cells. Canvas-based (same cheap
 * redraw-on-resize model as ClipWaveform), pointer-events-none, drawn over the
 * waveform but under the clip's own label chip.
 */
// One drawn word cell: clip-local pixel span [x0, x1], its text, and the RAW
// index of the word (into store.words) so a click can select exactly that word.
interface WordCell {
  x0: number;
  x1: number;
  text: string;
  rawIndex: number;
}

// Coral highlight fill for the SELECTED word's cell (matches the transcript's
// coral active word). Kept subtle so it reads as a highlight, not a solid block.
const WORD_SELECTED_FILL = "rgba(255, 107, 53, 0.32)";
const WORD_SELECTED_TEXT = "#fff";
// Teal wash for the word UNDER THE PLAYHEAD (Descript's karaoke word) -- a
// distinct hue from the coral selection so "now playing" reads apart from
// "selected". Fainter, since it moves every frame during playback.
const WORD_PLAYHEAD_FILL = "rgba(0, 212, 170, 0.22)";

/**
 * Compute the visible word cells (clip-local pixel spans + raw index) for a clip.
 * Shared by the drawing layer and the parent's click hit-test so both agree on
 * exactly where each word sits. A word straddling a clip edge is clipped to the
 * clip bounds so its cell never spills past the block.
 */
function computeWordCells(clip: Clip, width: number, words: Word[]): WordCell[] {
  const span = clip.srcEnd - clip.srcStart;
  if (span <= 0 || words.length === 0) return [];
  const out: WordCell[] = [];
  for (let i = 0; i < words.length; i++) {
    const wd = words[i];
    if (wd.end <= clip.srcStart || wd.start >= clip.srcEnd) continue;
    const s = Math.max(wd.start, clip.srcStart);
    const e = Math.min(wd.end, clip.srcEnd);
    out.push({
      x0: ((s - clip.srcStart) / span) * width,
      x1: ((e - clip.srcStart) / span) * width,
      text: wd.text,
      rawIndex: i,
    });
  }
  return out;
}

function ClipWordDividers({
  cells,
  width,
  height,
  selectedWordIndex,
  selectedWordRange,
  playheadWordIndex,
}: {
  cells: WordCell[];
  width: number;
  height: number;
  selectedWordIndex: number | null;
  /** Inclusive [lo, hi] raw-index span to wash coral (a drag/shift range). */
  selectedWordRange: { lo: number; hi: number } | null;
  playheadWordIndex: number | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (cells.length === 0) return;

    // 0) Cell washes (drawn first, UNDER the ticks + text). The playhead (karaoke)
    //    word gets a teal wash; the selected word gets a coral wash on top, so if
    //    the same cell is both, coral (the deliberate selection) wins visually.
    if (playheadWordIndex != null) {
      const ph = cells.find((c) => c.rawIndex === playheadWordIndex);
      if (ph) {
        ctx.fillStyle = WORD_PLAYHEAD_FILL;
        ctx.fillRect(ph.x0, 1, Math.max(1, ph.x1 - ph.x0), h - 2);
      }
    }
    // Coral wash over the WHOLE selected span: a drag/shift range covers every
    // cell whose rawIndex is within [lo, hi], so a multi-word selection reads as
    // one continuous band -- not just its endpoints. A single click has lo===hi,
    // so this washes exactly the one cell (same look as before). Falls back to
    // selectedWordIndex when no range is supplied.
    const range =
      selectedWordRange ??
      (selectedWordIndex != null ? { lo: selectedWordIndex, hi: selectedWordIndex } : null);
    if (range) {
      ctx.fillStyle = WORD_SELECTED_FILL;
      for (const c of cells) {
        if (c.rawIndex < range.lo || c.rawIndex > range.hi) continue;
        ctx.fillRect(c.x0, 1, Math.max(1, c.x1 - c.x0), h - 2);
      }
    }

    // 1) Divider lines at each cell boundary (the END edge of each word), thinned
    //    out when two land within MIN_WORD_GAP_PX so a fast passage stays legible.
    ctx.fillStyle = WORD_DIVIDER_COLOR;
    let lastX = -Infinity;
    for (const c of cells) {
      const x = Math.round(c.x1) + 0.5; // crisp 1px line at the cell's trailing edge
      if (x <= 1 || x >= w - 1) continue; // never draw on the clip's own edges
      if (x - lastX < MIN_WORD_GAP_PX) continue;
      lastX = x;
      ctx.fillRect(x, 2, 1, h - 4);
    }

    // 2) Word text inside each cell wide enough to hold it. Clipped to the cell
    //    so a long word never bleeds into its neighbours; a word that still
    //    overflows is truncated with an ellipsis. Vertically centered. The
    //    selected cell's text goes white so it pops on the coral fill.
    ctx.font = `500 ${WORD_FONT_PX}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = "middle";
    const midY = h / 2;
    const PAD = 4; // inner horizontal padding within a cell
    for (const c of cells) {
      const cellW = c.x1 - c.x0;
      if (cellW < MIN_CELL_PX_FOR_TEXT) continue;
      const avail = cellW - PAD * 2;
      if (avail <= 2) continue;
      const label = fitText(ctx, c.text, avail);
      if (!label) continue;
      // A cell inside the selected span gets white ink so it pops on the coral.
      const inRange = range != null && c.rawIndex >= range.lo && c.rawIndex <= range.hi;
      ctx.fillStyle = inRange ? WORD_SELECTED_TEXT : WORD_TEXT_COLOR;
      ctx.save();
      ctx.beginPath();
      ctx.rect(c.x0, 0, cellW, h);
      ctx.clip();
      ctx.fillText(label, c.x0 + PAD, midY);
      ctx.restore();
    }
  }, [cells, width, height, selectedWordIndex, selectedWordRange, playheadWordIndex]);

  if (cells.length === 0) return null;

  // Purely presentational: the canvas paints cells; hit-testing for clicks lives
  // in the parent's body handler (computeWordCells is shared) so a drag on the
  // clip body still works -- there is no covering interactive layer here.
  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full rounded-md"
      aria-hidden
    />
  );
}

/**
 * Truncate `text` with a trailing ellipsis so it fits within `maxPx` under the
 * ctx's current font. Returns "" if not even one character + ellipsis fits.
 */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
  if (ctx.measureText(text).width <= maxPx) return text;
  const ell = "…";
  if (ctx.measureText(ell).width > maxPx) return "";
  let lo = 0;
  let hi = text.length;
  // Largest prefix whose "prefix…" still fits.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + ell).width <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + ell : "";
}

// Subtle waveform styling -- a navigation aid, never the focus. Light neutral
// ink at low opacity so it reads behind the label without competing with it.
const WAVEFORM_COLOR = "rgba(226, 232, 240, 0.55)"; // slate-200-ish
const WAVEFORM_OPACITY = 0.25;

/**
 * A subtle audio waveform drawn behind a kept take clip's label -- a way to
 * spot pauses / beats at a glance. Renders to a <canvas> sized to the clip and
 * redraws ONLY when the clip's pixel size or the sampled peaks change (an
 * effect keyed on those), never per animation frame. Purely decorative:
 * pointer-events-none + low opacity so it never competes with the label or
 * intercepts drags. Renders nothing until peaks exist.
 */
function ClipWaveform({
  clip,
  width,
  height,
  waveform,
}: {
  clip: Clip;
  width: number;
  height: number;
  waveform: FaceWaveform | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // One bin per ~2 CSS px keeps the waveform crisp without over-sampling a
  // narrow clip. sliceClipPeaks reduces the whole-file peaks for THIS clip's
  // source range down to these bins; recomputed only when width/range change.
  const outBins = Math.max(4, Math.round(width / 2));
  const peaks = useMemo(
    () => sliceClipPeaks(waveform, clip.srcStart, clip.srcEnd, outBins),
    [waveform, clip.srcStart, clip.srcEnd, outBins]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Size the backing store for crisp lines on HiDPI; cap DPR so a big clip
    // never allocates an oversized canvas. Draw at CSS px in the scaled space.
    const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (peaks.length === 0) return;

    const mid = h / 2;
    // Leave a hair of vertical padding so peaks don't touch the clip edges.
    const maxAmp = mid - 1;
    const barW = w / peaks.length;

    ctx.fillStyle = WAVEFORM_COLOR;
    for (let i = 0; i < peaks.length; i++) {
      const amp = Math.max(0.5, peaks[i] * maxAmp);
      const x = i * barW;
      // Symmetric bar around the mid-line; min 1px wide so gaps don't vanish.
      ctx.fillRect(x, mid - amp, Math.max(1, barW * 0.7), amp * 2);
    }
  }, [peaks, width, height]);

  if (peaks.length === 0) return null;

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full rounded-md"
      style={{ opacity: WAVEFORM_OPACITY }}
      aria-hidden
    />
  );
}

/**
 * A single draggable clip block on the FACE track (or generically any
 * clip-shaped block). Renders kept clips solid, deleted clips as a thin
 * greyed-out ghost with a restore affordance.
 */
export function ClipBlock({
  clip,
  left,
  width,
  trackTop,
  trackHeight,
  isSelected,
  onSelect,
  onDragBodyStart,
  onDragEdgeStart,
  onDelete,
  onRestore,
  waveform = null,
  words,
  onWordCellClick,
  onWordCellDoubleClick,
  onWordRangeSelect,
  selectedWordIndex = null,
  selectedWordRange = null,
  playheadWordIndex = null,
}: ClipBlockProps) {
  const suppressClickRef = useRef(false);
  // Client-x where the body pointer went down, so the body click handler can tell
  // a discrete CLICK (word select) from the tail of a DRAG (clip move): a drag
  // past a few px must not also fire word selection on release.
  const pointerDownXRef = useRef<number | null>(null);

  // ---- inline caption-text edit (Descript wordbar parity) --------------------
  // Which WORD CELL (its raw index) is currently in inline edit mode (null =
  // none). Set by double-clicking a cell; cleared on commit/cancel. Mirrors the
  // transcript's editingIndex/editDraft/editInputRef/suppressClickRef model so a
  // double-click edits caption text without also firing word-select or a drag.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  // Live state of an in-progress WORD-RANGE drag on the wordbar (see
  // handleBodyPointerDown). Held in a ref so the pointermove/up handlers read the
  // latest without re-binding: `anchor` is the rawIndex the drag started on,
  // `focus` the last cell swept to, and `moved` flips true once the sweep leaves
  // the anchor cell (so a no-move release is treated as a plain single click, not
  // a 1-word range). null when no word-range drag is active.
  const wordDragRef = useRef<{ anchor: number; focus: number; moved: boolean } | null>(null);

  const clipWidth = Math.max(width, 6);

  // Visible word cells for THIS clip -- shared by the drawing layer and the body
  // click hit-test so both agree exactly where each word sits. Empty when no
  // words / not a kept take clip.
  const wordCells = useMemo(() => {
    if (!clip.kept || clip.kind !== "take" || !words || words.length === 0) return [];
    return computeWordCells(clip, clipWidth, words);
  }, [clip, clipWidth, words]);

  // Word cells "take over" once each averages enough px to hold text: the label
  // then yields to a corner tag, and clicks select words instead of the scene.
  // Mirror MIN_CELL_PX_FOR_TEXT so the visual + interactive thresholds agree.
  const wordsAreReadable =
    wordCells.length > 0 && clipWidth / wordCells.length >= MIN_CELL_PX_FOR_TEXT;

  // Hit-test a client-x against this clip's word cells -> the rawIndex of the cell
  // it lands in, or null if it falls in no cell (e.g. a sub-pixel gap). Clamps to
  // the nearest cell horizontally so a drag that sweeps PAST the last readable
  // cell still resolves to that edge word (a range never dead-zones at the ends).
  const hitTestWordCell = useCallback(
    (clientX: number, rect: DOMRect): number | null => {
      if (wordCells.length === 0) return null;
      const localX = clientX - rect.left;
      let nearest: WordCell | null = null;
      let nearestDist = Infinity;
      for (const c of wordCells) {
        if (localX >= c.x0 && localX < c.x1) return c.rawIndex; // direct hit
        // Track the closest cell by horizontal gap for the clamp-to-edge fallback.
        const dist = localX < c.x0 ? c.x0 - localX : localX - c.x1;
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = c;
        }
      }
      return nearest ? nearest.rawIndex : null;
    },
    [wordCells]
  );

  // Pointer-down on the clip body. Two disjoint modes, decided HERE:
  //   1) WORD-RANGE mode -- word cells are readable AND the down landed on a cell
  //      AND a range handler is wired. We do NOT start a clip move (and do NOT
  //      select the scene): a horizontal drag from here sweeps a word RANGE, and
  //      SHIFT+down extends the current selection to the clicked word. This is the
  //      Descript wordbar: drag to select across words, shift-click to extend.
  //   2) CLIP-MOVE mode -- everything else (zoomed out, or the down missed a cell,
  //      or no range handler): the existing behavior, select the scene + begin a
  //      clip body drag (reorder). Trim edges have their own handlers and
  //      stopPropagation, so they never reach here.
  const handleBodyPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!clip.kept) return;
      e.stopPropagation();
      suppressClickRef.current = false;
      pointerDownXRef.current = e.clientX;

      if (wordsAreReadable && onWordRangeSelect) {
        const rect = e.currentTarget.getBoundingClientRect();
        const hit = hitTestWordCell(e.clientX, rect);
        if (hit != null) {
          // SHIFT+click: extend the CURRENT selection to the clicked word. The
          // anchor is the existing selection's low end (or, if nothing is
          // selected yet, the clicked word itself -> a 1-word selection). No drag
          // is armed; this is a one-shot extend.
          if (e.shiftKey) {
            const anchor = selectedWordRange ? selectedWordRange.lo : hit;
            onWordRangeSelect(anchor, hit);
            // Swallow the synthesized click so handleBodyClick doesn't collapse
            // the extended range back to the single clicked word.
            suppressClickRef.current = true;
            return;
          }
          // Plain down on a cell: arm a word-range drag. Capture the pointer so a
          // sweep that leaves this block still tracks. The actual range fires on
          // move (once the sweep changes cells) and a no-move release falls back
          // to a single-word click in handleBodyPointerUp.
          wordDragRef.current = { anchor: hit, focus: hit, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
          return;
        }
      }

      // CLIP-MOVE mode: select the scene + start the body (reorder) drag.
      onSelect(clip.id);
      onDragBodyStart(clip, e.clientX);
    },
    [
      clip,
      wordsAreReadable,
      onWordRangeSelect,
      hitTestWordCell,
      selectedWordRange,
      onSelect,
      onDragBodyStart,
    ]
  );

  // Pointer-move during an armed word-range drag: hit-test the current x to a
  // cell and, once the sweep reaches a DIFFERENT cell than the anchor (or moves
  // on to yet another), push the live inclusive range. Marking `moved` here is
  // what distinguishes a real drag from a click on release. No-op unless a word
  // drag is armed (a clip-move drag is driven by Timeline's window listeners).
  const handleBodyPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = wordDragRef.current;
      if (!drag || !onWordRangeSelect) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const focus = hitTestWordCell(e.clientX, rect);
      if (focus == null || focus === drag.focus) return;
      drag.focus = focus;
      if (focus !== drag.anchor) drag.moved = true;
      onWordRangeSelect(drag.anchor, focus);
    },
    [onWordRangeSelect, hitTestWordCell]
  );

  // Pointer-up ends an armed word-range drag. A sweep that never left the anchor
  // cell is a plain CLICK -> select just that one word (same as before). A real
  // sweep already pushed its range on move, so there's nothing left to do but
  // clear the drag. suppressClickRef stops the synthesized click (handleBodyClick)
  // from re-firing a single-word select on top of the range we just set.
  const handleBodyPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = wordDragRef.current;
      if (!drag) return;
      wordDragRef.current = null;
      suppressClickRef.current = true;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      if (!drag.moved && onWordCellClick) onWordCellClick(drag.anchor);
    },
    [onWordCellClick]
  );

  // Body click: when word cells are readable and the pointer barely moved (a
  // click, not a drag), select the WORD under the cursor instead of the scene.
  // onSelect already ran in pointer-down (so the scene highlight/framing showed);
  // selecting a word clears that via the store's mutual-exclusion, so the net
  // result of a word-cell click is a WORD selection, and Delete cuts that word.
  // A word-range drag routes its click through pointer-up instead and sets
  // suppressClickRef, so this handler bails to avoid double-selecting.
  const handleBodyClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.stopPropagation();
      // suppressClickRef is armed by (a) a double-click opening the inline caption
      // editor, (b) a word-range drag release, or (c) a shift-click extend -- in
      // all three the trailing synthesized click must NOT also fire a single-word
      // select. Swallow it once (mirrors the transcript's onWordClick guard).
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      if (!wordsAreReadable || !onWordCellClick) return;
      const downX = pointerDownXRef.current;
      // Treat as a drag (not a word pick) if the pointer moved more than 4px.
      if (downX != null && Math.abs(e.clientX - downX) > 4) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      for (const c of wordCells) {
        if (localX >= c.x0 && localX < c.x1) {
          onWordCellClick(c.rawIndex);
          return;
        }
      }
    },
    [wordsAreReadable, onWordCellClick, wordCells]
  );

  // Double-click a WORD CELL -> open an inline caption-text editor over it,
  // exactly like the transcript's double-click-to-edit. Hit-tests the cell with
  // the SAME computeWordCells geometry the click handler uses, arms
  // suppressClickRef so the two clicks that compose the dblclick don't ALSO fire
  // word-select, and preventDefault/stopPropagation so it never starts a drag.
  const handleBodyDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (!wordsAreReadable || !onWordCellDoubleClick) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      for (const c of wordCells) {
        if (localX >= c.x0 && localX < c.x1) {
          e.preventDefault();
          // Swallow the trailing click so opening the editor doesn't also select
          // the word (handleBodyClick checks this ref).
          suppressClickRef.current = true;
          setEditingIndex(c.rawIndex);
          setEditDraft(c.text);
          return;
        }
      }
    },
    [wordsAreReadable, onWordCellDoubleClick, wordCells]
  );

  // Commit the inline edit via the parent's editWordText bridge (an empty draft
  // reverts to the raw word, which the store handles), then close the editor.
  // Disarm suppressClickRef so the user's NEXT single-click on a cell selects
  // its word instead of being swallowed (see the transcript's commitEdit).
  const commitEdit = useCallback(() => {
    if (editingIndex == null) return;
    onWordCellDoubleClick?.(editingIndex, editDraft);
    setEditingIndex(null);
    setEditDraft("");
    suppressClickRef.current = false;
  }, [editingIndex, editDraft, onWordCellDoubleClick]);

  const cancelEdit = useCallback(() => {
    setEditingIndex(null);
    setEditDraft("");
    suppressClickRef.current = false;
  }, []);

  // Focus + select-all the inline input the moment it opens (mirrors transcript).
  useEffect(() => {
    if (editingIndex == null) return;
    const el = editInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editingIndex]);

  // Clip-local pixel span of the cell being edited, so the inline input can sit
  // exactly over it. Recomputed from the shared wordCells; null when not editing
  // or the edited word has scrolled out of this clip's window.
  const editingCell = useMemo(
    () =>
      editingIndex == null
        ? null
        : wordCells.find((c) => c.rawIndex === editingIndex) ?? null,
    [editingIndex, wordCells]
  );

  const handleEdgePointerDown = useCallback(
    (edge: "start" | "end") => (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.preventDefault();
      onSelect(clip.id);
      onDragEdgeStart(clip, edge, e.clientX);
    },
    [clip, onSelect, onDragEdgeStart]
  );

  if (!clip.kept) {
    // Deleted clip: thin ghost marker, click to restore.
    return (
      <div
        data-clip-id={clip.id}
        className="absolute flex items-center justify-center gap-1 rounded border border-dashed border-neutral-600/60 bg-neutral-800/40 text-neutral-500 hover:text-neutral-300 hover:border-neutral-400 transition-colors group"
        style={{ left, width: Math.max(width, 22), top: trackTop, height: trackHeight }}
        onClick={(e) => {
          e.stopPropagation();
          onRestore(clip.id);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        title={`Restore "${clip.label}"`}
      >
        <ArrowCounterClockwise size={12} weight="bold" className="shrink-0" />
        {width > 60 && (
          <span className="truncate text-[10px] leading-none">{clip.label}</span>
        )}
      </div>
    );
  }

  const durationLabel = formatTimecode(clip.timelineEnd - clip.timelineStart, true);

  // Manual sub-scenes (carved with `/`) read in a TEAL accent so they stand out
  // from the coral-selected / neutral auto-cut scenes -- a glanceable "this is a
  // layer I made" marker. Same functionality, just a different color.
  const manual = clip.manualScene === true;
  const selectedBorder = manual
    ? "border-[#00d4aa] shadow-[0_0_0_2px_rgba(0,212,170,0.35)] z-10"
    : "border-[#FF6B35] shadow-[0_0_0_2px_rgba(255,107,53,0.35)] z-10";
  const idleBorder = manual
    ? "border-[#00d4aa]/60 hover:border-[#00d4aa] z-0"
    : "border-neutral-700 hover:border-neutral-500 z-0";

  return (
    <div
      data-clip-id={clip.id}
      className={`absolute rounded-md border shadow-sm select-none transition-shadow ${
        isSelected ? selectedBorder : idleBorder
      } ${clip.kind === "silence" ? "bg-[repeating-linear-gradient(45deg,#2a2a2a,#2a2a2a_4px,#333_4px,#333_8px)] opacity-60" : manual ? "bg-[#0c2f2a]" : "bg-neutral-800"}`}
      style={{ left, width: clipWidth, top: trackTop, height: trackHeight }}
      onPointerDown={handleBodyPointerDown}
      onPointerMove={handleBodyPointerMove}
      onPointerUp={handleBodyPointerUp}
      onClick={handleBodyClick}
      onDoubleClick={handleBodyDoubleClick}
    >
      {/* fill */}
      {clip.kind !== "silence" && (
        <div
          className="absolute inset-0 rounded-md"
          style={{
            background: isSelected
              ? "linear-gradient(180deg, rgba(255,107,53,0.28), rgba(255,107,53,0.12))"
              : "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))",
          }}
        />
      )}

      {/* audio waveform (kept take clips only) -- a subtle beat/pause finder
          drawn behind the label. Renders nothing until peaks are decoded, so
          the clip looks exactly as before while (or if) audio is unavailable. */}
      {clip.kind === "take" && (
        <ClipWaveform
          clip={clip}
          width={clipWidth}
          height={trackHeight}
          waveform={waveform}
        />
      )}

      {/* per-word cell grid (kept take clips only) -- a divider + the word text
          at each word inside this clip's source window, with the shared-selected
          word highlighted coral. Clicking a cell (see handleBodyClick) selects
          just that word, mirroring the transcript. Drawn OVER the waveform but
          under the label; skipped on clips too narrow to read a word grid. */}
      {wordCells.length > 0 && width >= MIN_CLIP_PX_FOR_WORDS && (
        <ClipWordDividers
          cells={wordCells}
          width={clipWidth}
          height={trackHeight}
          selectedWordIndex={selectedWordIndex}
          selectedWordRange={selectedWordRange}
          playheadWordIndex={playheadWordIndex}
        />
      )}

      {/* inline caption-text editor (Descript wordbar parity) -- swaps in over
          the double-clicked cell using its clip-local x0..x1 from computeWordCells,
          so it sits exactly on the word. Enter/blur commits via editWordText;
          Escape cancels; opening focuses + selects-all. Pointer/click events are
          stopped here so typing never starts a clip drag or re-selects the word.
          Coral border matches the transcript's inline input. */}
      {editingCell && (
        <input
          ref={editInputRef}
          type="text"
          aria-label="Edit caption text"
          value={editDraft}
          onChange={(e) => setEditDraft(e.target.value)}
          onBlur={commitEdit}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            // Keep these keys inside the input -- Timeline's Delete / Enter /
            // Escape handlers must not fire mid-edit.
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            }
          }}
          className="absolute z-20 rounded border border-[#FF6B35] bg-neutral-900 px-1 text-[10px] leading-none text-neutral-100 outline-none focus-visible:ring-1 focus-visible:ring-[#FF6B35]"
          style={{
            left: Math.max(0, editingCell.x0),
            top: 2,
            width: Math.max(28, editingCell.x1 - editingCell.x0),
            height: trackHeight - 4,
          }}
        />
      )}

      {/* left trim edge */}
      <div
        className="absolute left-0 top-0 h-full w-2 hover:bg-[#FF6B35]/50 rounded-l-md"
        onPointerDown={handleEdgePointerDown("start")}
      />
      {/* right trim edge */}
      <div
        className="absolute right-0 top-0 h-full w-2 hover:bg-[#FF6B35]/50 rounded-r-md"
        onPointerDown={handleEdgePointerDown("end")}
      />

      {/* label -- two modes. When word cells are too small to read (zoomed out),
          the label owns the block: centered name + duration, as before. Once the
          word grid is readable (zoomed in), the label collapses to a compact
          top-left tag on a dark backing so it stays legible WITHOUT covering the
          word text that now fills the row. */}
      {wordsAreReadable ? (
        <div className="absolute left-0 top-0 flex max-w-[70%] items-center gap-1 rounded-br-md rounded-tl-md bg-neutral-900/85 px-1.5 py-0.5 pointer-events-none">
          {clip.isKeeperTake && (
            <Star size={9} weight="fill" className="shrink-0 text-[#FF6B35]" />
          )}
          <span className="truncate text-[9px] font-medium leading-none text-neutral-300">
            {clip.label}
          </span>
        </div>
      ) : (
        <div className="relative h-full flex items-center gap-1 px-2.5 overflow-hidden pointer-events-none">
          {clip.isKeeperTake && (
            <Star size={11} weight="fill" className="shrink-0 text-[#FF6B35]" />
          )}
          <div className="flex flex-col min-w-0 leading-tight">
            <span className="truncate text-[11px] font-medium text-neutral-100">
              {clip.label}
            </span>
            {width > 70 && (
              <span className="truncate text-[9px] text-neutral-400">{durationLabel}</span>
            )}
          </div>
        </div>
      )}

      {/* delete button, shown on selection */}
      {isSelected && width > 34 && (
        <button
          type="button"
          className="absolute top-1 right-1 rounded p-0.5 bg-neutral-900/80 text-neutral-300 hover:text-white hover:bg-red-600/80 pointer-events-auto transition-colors"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(clip.id);
          }}
          title="Delete clip"
        >
          <TrashSimple size={11} weight="bold" />
        </button>
      )}
    </div>
  );
}
