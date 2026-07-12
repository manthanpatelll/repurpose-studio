"use client";

// ===========================================================================
// REPURPOSE STUDIO -- TranscriptContextMenu
// ===========================================================================
// The custom right-click menu for a transcript word selection: Duplicate +
// Delete (no Mute -- that was dropped for the transcript). Replaces Chrome's
// native context menu. Adapted from app/reel-overlay/BeatContextMenu.tsx (same
// fixed x/y placement, Escape + outside-click close, coral accent), rebuilt
// locally so the two app dirs stay decoupled.
// ===========================================================================

import { useEffect, useRef } from "react";
import { CopySimple, Trash } from "@phosphor-icons/react";

const CORAL = "#FF6B35";

export interface TranscriptMenuState {
  x: number;
  y: number;
}

interface Props {
  state: TranscriptMenuState | null;
  /** How many words the active selection covers -- shown as a footer hint. */
  selectionCount: number;
  /** Duplicate is only offered when the selection maps to a single clip. */
  canDuplicate: boolean;
  onClose: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function TranscriptContextMenu({
  state,
  selectionCount,
  canDuplicate,
  onClose,
  onDuplicate,
  onDelete,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state) return;
    const onDoc = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) onClose();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    // Right-clicking elsewhere should also dismiss this menu.
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("contextmenu", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("contextmenu", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [state, onClose]);

  if (!state) return null;

  const item =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-[180px] rounded-md border border-zinc-700 bg-zinc-950 py-1 text-zinc-200 shadow-2xl"
      style={{ left: state.x, top: state.y }}
    >
      <button
        type="button"
        role="menuitem"
        className={item}
        disabled={!canDuplicate}
        title={
          canDuplicate
            ? "Duplicate this word span"
            : "Select words within a single take to duplicate"
        }
        onClick={() => {
          onDuplicate();
          onClose();
        }}
      >
        <CopySimple size={14} weight="bold" aria-hidden="true" style={{ color: CORAL }} />
        Duplicate
      </button>

      <button
        type="button"
        role="menuitem"
        className={`${item} text-red-300 hover:bg-red-950/40`}
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        <Trash size={14} weight="bold" aria-hidden="true" />
        Delete
      </button>

      <div className="mt-1 border-t border-zinc-800 px-3 pt-1 text-[10px] text-zinc-600">
        {selectionCount} {selectionCount === 1 ? "word" : "words"} selected
      </div>
    </div>
  );
}
