"use client";

// ===========================================================================
// REPURPOSE STUDIO -- WordTranscript
// ===========================================================================
// The editable word-level transcript that REPLACES the old take list. This is
// the Descript-parity surface: the raw whole-recording transcript reflows into
// the finished short (TIMELINE order, not source order), every kept word is an
// editable button, deleted words strike through (click to restore), and the
// footage that never made the short hides behind a "show full recording" fold.
//
// LOAD-BEARING FACT (see lib/repurpose/word-clip-map.ts):
//   store.words is the RAW whole-recording transcript (thousands of words).
//   store.clips is only the ~30-60s selectShort window, so MOST words map to NO
//   kept clip. buildWordViews classifies each raw word into kept/deleted/outside;
//   orderedForDisplay reflows kept+deleted into TIMELINE order (selectShort can
//   place clips out of source order) and buckets the rest as "outside".
//
// EDIT MODEL (store owns the truth):
//   - Delete a KEPT word (or a selected range) -> deleteWords(min, max). This
//     does the forward cut and leaves a restorable kept:false ghost clip.
//   - Click a DELETED word -> restoreWords(index, index) -- flips the ghost back.
//   Both take RAW word indices (WordView.index), NOT display order.
//
// KEYBOARD OWNERSHIP: this container owns Delete/Backspace/Enter/Escape via a
// focus-scoped onKeyDown (Timeline.tsx yields the keydown when it originates
// inside #transcript-panel). We only preventDefault those four keys so Space /
// J / K / L / Cmd+Z still bubble to the TransportBar + Timeline.
// ===========================================================================

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Broom, ArrowsInLineHorizontal } from "@phosphor-icons/react";
import { useRepurposeStore } from "@/lib/repurpose/store";
import {
  buildWordViews,
  orderedForDisplay,
  type WordView,
} from "@/lib/repurpose/word-clip-map";
import { timelineToSourceTime } from "@/lib/repurpose/time-map";
import { buildOverrideByStartMs } from "@/lib/repurpose/transcript-export";
import {
  TranscriptContextMenu,
  type TranscriptMenuState,
} from "./TranscriptContextMenu";

/** Inclusive [lo, hi] of a possibly-reversed selection anchor/focus pair. */
function normalizeRange(a: number, b: number): { lo: number; hi: number } {
  return a <= b ? { lo: a, hi: b } : { lo: b, hi: a };
}

export function WordTranscript() {
  const words = useRepurposeStore((s) => s.words);
  const clips = useRepurposeStore((s) => s.clips);
  const deletedWordIndices = useRepurposeStore((s) => s.deletedWordIndices);
  const playhead = useRepurposeStore((s) => s.playhead);
  const setPlayhead = useRepurposeStore((s) => s.setPlayhead);
  const deleteWords = useRepurposeStore((s) => s.deleteWords);
  const restoreWords = useRepurposeStore((s) => s.restoreWords);
  const selectWords = useRepurposeStore((s) => s.selectWords);
  // The shared word selection, written by the timeline word cells too. When it
  // changes from OUTSIDE this panel (a timeline cell click), mirror it into the
  // local `selection` so the transcript highlights the same word.
  const selectedWordRange = useRepurposeStore((s) => s.selectedWordRange);
  const editWordText = useRepurposeStore((s) => s.editWordText);
  const duplicateClip = useRepurposeStore((s) => s.duplicateClip);
  const removeFillerWords = useRepurposeStore((s) => s.removeFillerWords);
  const tightenWordGaps = useRepurposeStore((s) => s.tightenWordGaps);
  const captionBlocks = useRepurposeStore((s) => s.captionBlocks);

  // Local selection over RAW word indices. anchor is where a drag/shift-extend
  // pivots; focus is the moving end (and the keyboard cursor). null = nothing.
  const [selection, setSelection] = useState<{ anchor: number; focus: number } | null>(
    null
  );
  // True while a pointer drag is extending the selection -- suppresses the
  // playhead auto-scroll so the view doesn't fight the user's drag.
  const draggingRef = useRef(false);
  // Announced to screen readers after a delete/restore.
  const [announce, setAnnounce] = useState("");
  // Custom right-click menu (Duplicate / Delete) anchored at the cursor. null =
  // closed. Opening it replaces Chrome's native menu (the word button's
  // onContextMenu preventDefault()s that).
  const [menu, setMenu] = useState<TranscriptMenuState | null>(null);

  // Which RAW word index is currently in inline caption-text edit mode (null =
  // none). Set by double-clicking a kept word; cleared on commit/cancel.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  // Draft text held while the inline input is open.
  const [editDraft, setEditDraft] = useState("");
  // Guards the single-click seek when a double-click just fired on the same
  // word (dblclick lands after two clicks, so onClick would also seek).
  const suppressClickRef = useRef(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const activeWordRef = useRef<HTMLButtonElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const deletedSet = useMemo(
    () => new Set(deletedWordIndices),
    [deletedWordIndices]
  );

  // Map source-start-time (ms, rounded) -> the on-screen caption text for that
  // word, ONLY where it differs from the raw word (a real textOverride). Shared
  // builder with the Copy/.srt output actions (transcript-export) so the key
  // scheme can never drift. Lets us mark edited words with a dotted underline.
  const overrideByStartMs = useMemo(
    () => buildOverrideByStartMs(captionBlocks),
    [captionBlocks]
  );

  const isEdited = useCallback(
    (view: WordView) => overrideByStartMs.has(Math.round(view.word.start * 1000)),
    [overrideByStartMs]
  );

  const { inShort, outside } = useMemo(() => {
    const views = buildWordViews(words, clips, deletedSet);
    return orderedForDisplay(views);
  }, [words, clips, deletedSet]);

  // Which raw word index is under the playhead (coral highlight). Compute via
  // the SAME forward map the exporter uses: map the output playhead to a source
  // time, then find the kept word whose [start, end) contains it.
  const activeIndex = useMemo(() => {
    const srcT = timelineToSourceTime(clips, playhead);
    if (srcT == null) return null;
    let best: number | null = null;
    for (const v of inShort) {
      if (v.state !== "kept") continue;
      if (srcT >= v.word.start && srcT < v.word.end) return v.index;
      // Fallback: nearest kept word that has already started, in case the
      // playhead sits in a sub-word seam.
      if (v.word.start <= srcT) best = v.index;
    }
    return best;
  }, [clips, playhead, inShort]);

  // The ordered list of in-short raw indices -- lets arrow keys walk display order.
  const orderedIndices = useMemo(() => inShort.map((v) => v.index), [inShort]);

  // ---- Descript-style cut-boundary markers ----------------------------------
  // Descript drops a thin "¦" edit marker in the transcript wherever a cut
  // removed words between two kept ones, so "content was removed here" reads at a
  // glance. We derive it PURELY from the word views + deletedSet (no store touch):
  // walking the timeline-ordered `inShort`, we track the previous KEPT word's RAW
  // index and, when we reach the next KEPT word, ask whether any raw index
  // strictly BETWEEN them is deleted (a ghost was cut out here). If so, the seam
  // right before this kept word earns a marker. The deleted (ghost) words still
  // render inline; this marker sits at the kept->kept seam that spans them, and is
  // visually distinct (coral, taller, bolder) from the faint per-word left
  // dividers that merely bound every word. Keyed by render position for O(1)
  // lookup in the render loop.
  const cutBeforePos = useMemo(() => {
    const set = new Set<number>();
    let prevKeptIndex: number | null = null;
    inShort.forEach((view, pos) => {
      if (view.state !== "kept") return;
      if (prevKeptIndex != null) {
        // Any deleted raw index in the open interval (prevKeptIndex, index)
        // means a removed word sits between these two kept words -> a cut seam.
        for (let i = prevKeptIndex + 1; i < view.index; i++) {
          if (deletedSet.has(i)) {
            set.add(pos);
            break;
          }
        }
      }
      prevKeptIndex = view.index;
    });
    return set;
  }, [inShort, deletedSet]);

  // Auto-scroll the active word into view when the playhead moves, but never
  // while the user is actively selecting (that would yank the view mid-drag).
  useEffect(() => {
    if (draggingRef.current) return;
    if (activeIndex == null) return;
    const el = activeWordRef.current;
    if (!el) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [activeIndex]);

  // Clicking a word seeks the playhead to it. The WORD selection is owned by the
  // pointer-down (it sets local `selection`, which syncs to the store's shared
  // `selectedWordRange` and clears `selectedClipId` via selectWords). We do NOT
  // selectClip the carrier scene here: that would route a subsequent Delete to
  // the whole-scene path instead of this panel's word delete. Net effect: click
  // a word, press Delete, only that word is cut -- never the whole scene.
  const seekToWord = useCallback(
    (view: WordView) => {
      if (view.timelineT != null) setPlayhead(view.timelineT);
    },
    [setPlayhead]
  );

  const commitDelete = useCallback(
    (lo: number, hi: number) => {
      const before = deletedWordIndices.length;
      deleteWords(lo, hi);
      const after = useRepurposeStore.getState().deletedWordIndices.length;
      const n = after - before;
      if (n > 0) setAnnounce(`${n} ${n === 1 ? "word" : "words"} removed`);
    },
    [deleteWords, deletedWordIndices.length]
  );

  const commitRestore = useCallback(
    (lo: number, hi: number) => {
      const before = deletedWordIndices.length;
      restoreWords(lo, hi);
      const after = useRepurposeStore.getState().deletedWordIndices.length;
      const n = before - after;
      if (n > 0) setAnnounce(`${n} ${n === 1 ? "word" : "words"} restored`);
    },
    [restoreWords, deletedWordIndices.length]
  );

  // Remove all filler words ("um", "uh", ...) in one pass. The store does the
  // whole cut atomically (one history entry) and returns how many it removed;
  // we route the result through the SAME live region as delete/restore.
  const onRemoveFillers = useCallback(() => {
    const n = removeFillerWords();
    setAnnounce(
      n > 0
        ? `Removed ${n} filler ${n === 1 ? "word" : "words"}`
        : "No filler words found"
    );
  }, [removeFillerWords]);

  // Shorten word gaps: pull the dead air off every take, leaving a 150ms breath.
  // One-shot, manual (like Remove fillers) -- never auto. Routes its result
  // through the SAME live region as delete/restore/fillers.
  const onTightenGaps = useCallback(() => {
    const n = tightenWordGaps(0.15);
    setAnnounce(
      n > 0
        ? `Tightened ${n} ${n === 1 ? "gap" : "gaps"}`
        : "Gaps already tight"
    );
  }, [tightenWordGaps]);

  // ---- copy transcript / download .srt ---------------------------------------
  // Both act on the CURRENT short: kept words only, output time, caption edits
  // applied -- the same segments a viewer would read as captions. Copy puts
  // "[m:ss] line" rows on the clipboard; the .srt is a standard subtitle file.
  // Copy / .srt output actions moved to the "Transcript" title bar
  // (TranscriptOutputActions). Their handlers + copied state moved with them.

  // Auto-clear the live-region message ~2.5s after it changes so a stale toast
  // never lingers. Show/hide only -- no animation -- so it is fine under
  // prefers-reduced-motion as-is. Empty message means nothing to clear.
  useEffect(() => {
    if (!announce) return;
    const t = window.setTimeout(() => setAnnounce(""), 2500);
    return () => window.clearTimeout(t);
  }, [announce]);

  // ---- two-way sync of the local selection <-> the shared store range --------
  // The local `selection` (anchor/focus) drives this panel's rich interactions
  // (drag, arrows, context menu). The store's `selectedWordRange` is the SHARED
  // truth the timeline word cells read/write. We keep them in lock-step, guarding
  // each direction by value so the two effects never ping-pong.

  // Push local -> store whenever the local selection changes. Normalize to
  // {lo, hi}; a no-op guard (already equal) prevents a redundant store write.
  useEffect(() => {
    const cur = useRepurposeStore.getState().selectedWordRange;
    if (!selection) {
      // Only clear the store range if WE are the ones that had it (its lo===hi
      // range came from us). Clearing unconditionally would wipe a timeline
      // selection; but a null local selection paired with a set store range is
      // exactly the "timeline selected a word" case handled by the pull effect,
      // so do nothing here and let that effect own it.
      return;
    }
    const { lo, hi } = normalizeRange(selection.anchor, selection.focus);
    if (cur && cur.lo === lo && cur.hi === hi) return; // already in sync
    selectWords(lo, hi);
  }, [selection, selectWords]);

  // Pull store -> local when the store range was set from OUTSIDE (a timeline
  // cell click) to a value our local selection doesn't already match. Collapses
  // to a single-word local selection (anchor===focus) so arrows/delete work.
  useEffect(() => {
    if (!selectedWordRange) {
      // Store cleared the word selection (e.g. after a delete, or a clip was
      // selected). Drop our local selection to match so nothing stays highlighted.
      if (selection) setSelection(null);
      return;
    }
    const localNorm = selection
      ? normalizeRange(selection.anchor, selection.focus)
      : null;
    if (
      localNorm &&
      localNorm.lo === selectedWordRange.lo &&
      localNorm.hi === selectedWordRange.hi
    ) {
      return; // already matches -- this update came from us
    }
    setSelection({ anchor: selectedWordRange.lo, focus: selectedWordRange.hi });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWordRange]);

  // ---- inline caption-text edit ---------------------------------------------
  // Double-click a KEPT word -> open a small inline input pre-filled with the
  // word's current text. Enter/blur commits via editWordText (empty reverts to
  // the raw word); Escape cancels. Only the on-screen caption text changes --
  // footage, timing and words[] are untouched (store handles that).
  const beginEdit = useCallback(
    (view: WordView) => {
      if (view.state !== "kept") return;
      // A caption-text override may already be showing for this word; seed the
      // draft with whatever the viewer currently reads, else the raw word.
      const shown = overrideByStartMs.get(Math.round(view.word.start * 1000));
      setEditingIndex(view.index);
      setEditDraft(shown ?? view.word.text);
    },
    [overrideByStartMs]
  );

  const commitEdit = useCallback(() => {
    if (editingIndex == null) return;
    editWordText(editingIndex, editDraft);
    setEditingIndex(null);
    setEditDraft("");
    // The double-click that opened this editor left suppressClickRef armed (the
    // word button unmounted before any trailing onClick could consume it). Clear
    // it here so the user's NEXT single-click on a word seeks instead of being
    // swallowed.
    suppressClickRef.current = false;
  }, [editingIndex, editDraft, editWordText]);

  const cancelEdit = useCallback(() => {
    setEditingIndex(null);
    setEditDraft("");
    // See commitEdit: disarm the double-click guard so the next click isn't lost.
    suppressClickRef.current = false;
  }, []);

  // Focus + select-all the inline input the moment it opens.
  useEffect(() => {
    if (editingIndex == null) return;
    const el = editInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editingIndex]);

  const onWordDoubleClick = useCallback(
    (view: WordView) => (e: React.MouseEvent<HTMLButtonElement>) => {
      if (view.state !== "kept") return;
      e.preventDefault();
      e.stopPropagation();
      // The two clicks that make up this dblclick already fired their onClick;
      // suppress the next one so the seek that would follow is swallowed.
      suppressClickRef.current = true;
      beginEdit(view);
    },
    [beginEdit]
  );

  // ---- pointer selection ----------------------------------------------------
  const onWordPointerDown = useCallback(
    (index: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
      // Left button only; let modifier-less right-clicks / middle be ignored.
      if (e.button !== 0) return;
      draggingRef.current = true;
      if (e.shiftKey && selection) {
        setSelection({ anchor: selection.anchor, focus: index });
      } else {
        setSelection({ anchor: index, focus: index });
      }
    },
    [selection]
  );

  const onWordPointerEnter = useCallback(
    (index: number) => () => {
      if (!draggingRef.current) return;
      setSelection((prev) =>
        prev ? { anchor: prev.anchor, focus: index } : { anchor: index, focus: index }
      );
    },
    []
  );

  useEffect(() => {
    const end = () => {
      draggingRef.current = false;
    };
    window.addEventListener("pointerup", end);
    return () => window.removeEventListener("pointerup", end);
  }, []);

  const onWordClick = useCallback(
    (view: WordView) => (e: React.MouseEvent<HTMLButtonElement>) => {
      // The second click of a double-click set this flag; swallow this click so
      // opening the caption-text editor doesn't ALSO seek the playhead.
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      // Shift-click is a range extend handled in pointerdown; don't also seek.
      if (e.shiftKey) return;
      if (view.state === "deleted") {
        commitRestore(view.index, view.index);
        return;
      }
      // Kept word -> seek + select its clip.
      seekToWord(view);
    },
    [commitRestore, seekToWord]
  );

  // ---- right-click context menu ---------------------------------------------
  // Resolve the single clip a selection maps to, or null when it spans zero /
  // multiple clips. Duplicate is a whole-clip copy (duplicateClip), so it is
  // only offered when every KEPT word in the range shares one carrier clip.
  const selectionClipId = useMemo((): string | null => {
    if (!selection) return null;
    const { lo, hi } = normalizeRange(selection.anchor, selection.focus);
    let clipId: string | null = null;
    for (const v of inShort) {
      if (v.index < lo || v.index > hi) continue;
      if (v.state !== "kept" || !v.clipId) continue;
      if (clipId == null) clipId = v.clipId;
      else if (clipId !== v.clipId) return null; // spans >1 clip
    }
    return clipId;
  }, [selection, inShort]);

  const selectionCount = useMemo(() => {
    if (!selection) return 0;
    const { lo, hi } = normalizeRange(selection.anchor, selection.focus);
    return hi - lo + 1;
  }, [selection]);

  // Right-click a word -> open OUR menu, never Chrome's. If the word isn't part
  // of the current selection, collapse the selection onto it first so the menu
  // acts on what the user pointed at.
  const onWordContextMenu = useCallback(
    (index: number) => (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const inSel =
        selection != null &&
        (() => {
          const { lo, hi } = normalizeRange(selection.anchor, selection.focus);
          return index >= lo && index <= hi;
        })();
      if (!inSel) setSelection({ anchor: index, focus: index });
      setMenu({ x: e.clientX, y: e.clientY });
    },
    [selection]
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  const onMenuDelete = useCallback(() => {
    if (!selection) return;
    const { lo, hi } = normalizeRange(selection.anchor, selection.focus);
    commitDelete(lo, hi);
  }, [selection, commitDelete]);

  // Duplicate the selection's carrier clip (a clean, kept copy right after it).
  // Simplest correct path per the plan: a transcript word-span maps to a clip,
  // so reuse duplicateClip rather than inventing a partial-word duplicate.
  const onMenuDuplicate = useCallback(() => {
    if (!selectionClipId) return;
    duplicateClip(selectionClipId);
    setAnnounce("Duplicated");
  }, [selectionClipId, duplicateClip]);

  // ---- keyboard (focus-scoped) ----------------------------------------------
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      // Only claim the four editing keys; everything else (Space/J/K/L/Cmd+Z)
      // bubbles to the TransportBar + Timeline.
      const focusIndex = selection?.focus ?? null;

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (selection) {
          const { lo, hi } = normalizeRange(selection.anchor, selection.focus);
          commitDelete(lo, hi);
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        if (focusIndex != null) {
          const view = inShort.find((v) => v.index === focusIndex);
          if (view) seekToWord(view);
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        setSelection(null);
        // Also clear the SHARED store range: the push effect deliberately skips
        // the null case (the pull effect owns null), so without this the store
        // range would linger and keep a stale coral highlight on the timeline
        // word cells. Clearing here keeps both surfaces in lock-step.
        selectWords(null);
        return;
      }

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (orderedIndices.length === 0) return;
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const pos =
          focusIndex == null
            ? dir > 0
              ? -1
              : orderedIndices.length
            : orderedIndices.indexOf(focusIndex);
        const nextPos = Math.max(
          0,
          Math.min(orderedIndices.length - 1, pos + dir)
        );
        const nextIndex = orderedIndices[nextPos];
        setSelection({ anchor: nextIndex, focus: nextIndex });
        const view = inShort.find((v) => v.index === nextIndex);
        if (view) seekToWord(view);
      }
    },
    [selection, inShort, orderedIndices, commitDelete, seekToWord, selectWords]
  );

  const selRange = selection
    ? normalizeRange(selection.anchor, selection.focus)
    : null;
  const isSelected = (index: number) =>
    selRange != null && index >= selRange.lo && index <= selRange.hi;

  const reduceClass = "motion-reduce:transition-none";

  if (words.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Load your raw .srt (the one Descript exported, with all the retakes) to
        detect takes and build the timeline.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label="Editable transcript. Click a word to seek, select and press Delete to remove, click a removed word to restore."
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="h-full min-h-0 overflow-y-auto px-3 py-3 outline-none focus-visible:ring-1 focus-visible:ring-[#FF6B35]/40"
    >
      {/* Transcript rail header -- one-shot cleanups that act on the whole short.
          Sits above the flowing words so it never overlaps them. */}
      <div className="mb-3 flex items-center justify-end gap-2 border-b border-border pb-2">
        <button
          type="button"
          onClick={onTightenGaps}
          disabled={words.length === 0}
          title="Shorten word gaps: pull the dead air off every take (leaves a 150ms breath)"
          className={[
            "inline-flex items-center gap-1.5 rounded-md border border-[#FF6B35]/40 px-2.5 py-1",
            "text-[11px] font-medium text-[#FF6B35] transition-colors",
            reduceClass,
            "hover:bg-[#FF6B35]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6B35]",
            "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
          ].join(" ")}
        >
          <ArrowsInLineHorizontal size={14} weight="bold" aria-hidden="true" />
          Tighten gaps
        </button>
        <button
          type="button"
          onClick={onRemoveFillers}
          disabled={words.length === 0}
          title="Remove filler words (um, uh, ...) across the whole short"
          className={[
            "inline-flex items-center gap-1.5 rounded-md border border-[#FF6B35]/40 px-2.5 py-1",
            "text-[11px] font-medium text-[#FF6B35] transition-colors",
            reduceClass,
            "hover:bg-[#FF6B35]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6B35]",
            "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
          ].join(" ")}
        >
          <Broom size={14} weight="bold" aria-hidden="true" />
          Remove fillers
        </button>
        {/* Copy / .srt output actions moved UP into the "Transcript" title bar
            (TranscriptPanel -> TranscriptOutputActions) so this narrow rail holds
            only the two coral cleanup buttons and never overflows. */}
      </div>

      {/* The short, reflowed into timeline order. Each word is its own cell with
          a thin left divider between consecutive words, so the boundary of every
          spoken word reads at a glance (mirrors the timeline clip's word ticks).
          gap-x is 0 so the dividers sit flush like cells; per-word px gives the
          words breathing room inside their cell. */}
      <p
        className="flex flex-wrap gap-y-1 text-[13px] leading-relaxed select-none"
        aria-label="Words in the short"
      >
        {inShort.map((view, pos) => {
          const deleted = view.state === "deleted";
          const active = view.index === activeIndex;
          const selected = isSelected(view.index);
          const editing = view.index === editingIndex;
          const edited = !deleted && isEdited(view);
          // A thin divider on the LEFT of every word but the first, so words
          // read as adjacent cells. Suppressed on the active word (its coral
          // fill already bounds it) so the line never clashes with the pill.
          const showDivider = pos > 0 && !active;
          // Descript-style cut marker: a coral "¦" seam sits BEFORE this word
          // when a removed word was cut out between it and the previous kept
          // word (see cutBeforePos). Taller/bolder + coral so it reads as an
          // edit boundary, distinct from the faint per-word cell dividers.
          const cutBefore = cutBeforePos.has(pos);

          // A word cell is optionally preceded by the coral cut marker. We wrap
          // the marker + the cell (button or inline editor) in a Fragment so the
          // marker flows inline with the words without disturbing the flexbox.
          const cutMarker = cutBefore ? (
            <span
              key={`cut-${view.index}`}
              aria-hidden="true"
              title="Content removed here"
              className="mx-0.5 self-stretch border-l-2 border-[#FF6B35]/70"
            />
          ) : null;

          // Inline caption-text editor -- swaps in for the word button while
          // this word is being edited. Sized to the draft so it flows inline.
          if (editing) {
            return (
              <Fragment key={view.index}>
                {cutMarker}
                <input
                  ref={editInputRef}
                  type="text"
                  aria-label="Edit caption text"
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    // Keep these keys inside the input -- the container's Delete
                    // / Enter / Escape handlers must not fire mid-edit.
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitEdit();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelEdit();
                    }
                  }}
                  size={Math.max(1, editDraft.length)}
                  className="rounded border border-[#FF6B35] bg-background px-1 py-0.5 text-[13px] leading-relaxed text-foreground outline-none focus-visible:ring-1 focus-visible:ring-[#FF6B35]"
                />
              </Fragment>
            );
          }

          return (
            <Fragment key={view.index}>
              {cutMarker}
              <button
                ref={active ? activeWordRef : undefined}
                type="button"
                aria-pressed={deleted ? true : undefined}
                aria-current={active ? "true" : undefined}
                onPointerDown={onWordPointerDown(view.index)}
                onPointerEnter={onWordPointerEnter(view.index)}
                onClick={onWordClick(view)}
                onDoubleClick={onWordDoubleClick(view)}
                onContextMenu={onWordContextMenu(view.index)}
                title={
                  deleted
                    ? "Removed from the short -- click to restore"
                    : "Click to seek here -- double-click to edit caption text"
                }
                className={[
                  "rounded px-1.5 py-0.5 transition-colors duration-150",
                  reduceClass,
                  "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6B35]",
                  // Per-word divider: a faint left border turns the flowing text
                  // into readable word cells. border-l always reserves the 1px
                  // so words never shift when the divider toggles with selection.
                  "border-l",
                  showDivider ? "border-border/70" : "border-transparent",
                  deleted
                    ? "text-muted-foreground line-through opacity-50 hover:opacity-70"
                    : "text-foreground/90 hover:bg-white/5",
                  // Edited-caption marker as a dotted UNDERLINE (not a bottom
                  // border) so it never turns the per-word left divider dotted.
                  edited ? "underline decoration-dotted decoration-[#FF8F6B] underline-offset-2" : "",
                  active && !deleted
                    ? "bg-[#FF6B35] text-white hover:bg-[#FF6B35]"
                    : "",
                  selected && !active
                    ? "bg-[#FF6B35]/20"
                    : "",
                ].join(" ")}
              >
                {edited
                  ? overrideByStartMs.get(Math.round(view.word.start * 1000))
                  : view.word.text}
              </button>
            </Fragment>
          );
        })}
      </p>

      {/* The full recording -- everything that never made the short, folded away
          by default so the rail reads as the finished short. Non-interactive. */}
      {outside.length > 0 && (
        <details className="mt-4 border-t border-border pt-3">
          <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground/80">
            Show full recording ({outside.length}{" "}
            {outside.length === 1 ? "word" : "words"} not in the short)
          </summary>
          <p className="mt-2 flex flex-wrap gap-x-1 gap-y-1 text-[13px] leading-relaxed text-muted-foreground opacity-40 select-text">
            {outside.map((view) => (
              <span key={view.index}>{view.word.text}</span>
            ))}
          </p>
        </details>
      )}

      {/* SR-only live region: announces edits without stealing focus. */}
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>

      {/* Custom right-click menu (Duplicate / Delete). Fixed-positioned at the
          cursor; closes on Escape / outside-click / another right-click. */}
      <TranscriptContextMenu
        state={menu}
        selectionCount={selectionCount}
        canDuplicate={selectionClipId != null}
        onClose={closeMenu}
        onDuplicate={onMenuDuplicate}
        onDelete={onMenuDelete}
      />
    </div>
  );
}
