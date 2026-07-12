"use client";

// ===========================================================================
// REPURPOSE STUDIO -- CaptionPanel
// ===========================================================================
// The Inspector rail's caption control panel. Sits below ColorAdjustPanel and
// drives the burned-in word-level captions. Every control writes to the store
// (setCaptionsEnabled / setCaptionTemplate / patchCaptionStyle /
// patchCaptionBlock), which the live PreviewCanvas AND the MP4 export both read
// through the same drawCaptions contract -- so what you tweak here is exactly
// what burns into the Reel.
//
// The template gallery mirrors ColorAdjustPanel's GradeTile: each tile is a
// DPR-correct <canvas> that renders a LIVE sample of the template (a fake
// one-word block drawn over a dark gradient via drawCaptions), so Manthan sees
// the real look, not a static thumbnail. loadCaptionFonts() runs on mount and
// re-triggers a tile redraw once faces are ready (canvas text falls back to a
// system font before the faces load).
// ===========================================================================

import { useEffect, useRef, useState } from "react";
import { HexColorPicker, HexColorInput } from "react-colorful";
import {
  Power,
  TextAa,
  Prohibit,
  CursorClick,
  ArrowUUpLeft,
} from "@phosphor-icons/react";
import { useRepurposeStore } from "@/lib/repurpose/store";
import {
  CAPTION_TEMPLATE_ORDER,
  CAPTION_TEMPLATE_LABELS,
  CAPTION_TEMPLATES,
  drawCaptions,
  resolveBlockStyle,
  activeCaptionBlockAt,
  type CaptionTemplateId,
  type CaptionAnim,
  type CaptionDensity,
  type CaptionBlock,
  type CaptionStyle,
} from "@/lib/repurpose/captions";
import {
  CAPTION_FONTS,
  loadCaptionFonts,
  type CaptionFontId,
} from "@/lib/repurpose/caption-fonts";
import { timelineToSourceTime } from "@/lib/repurpose/time-map";

// Template preview tile logical size (CSS px). Backing store is DPR-scaled.
const TILE_W = 84;
const TILE_H = 60;

// One-tap brand quick-swatches shown above every color picker.
const QUICK_SWATCHES = [
  "#FFFFFF",
  "#000000",
  "#FF6B35",
  "#00d4aa",
  "#FFD93D",
  "#39FF14",
] as const;

// The editable color slots, mapped to their CaptionStyle field.
type ColorSlot = "fill" | "activeFill" | "strokeColor" | "boxColor" | "glowColor";

const COLOR_SLOTS: { slot: ColorSlot; label: string; nullable: boolean }[] = [
  { slot: "fill", label: "Text", nullable: false },
  { slot: "activeFill", label: "Active", nullable: false },
  { slot: "strokeColor", label: "Stroke", nullable: true },
  { slot: "boxColor", label: "Box", nullable: true },
  { slot: "glowColor", label: "Glow", nullable: true },
];

const ANIM_OPTIONS: CaptionAnim[] = ["none", "fade", "pop", "spring", "wipe", "punch"];

// A fake one-word block reused by every tile so the preview shows real text.
const PREVIEW_BLOCK: CaptionBlock = {
  id: "preview",
  words: [{ text: "HELLO", start: 0, end: 1 }],
  start: 0,
  end: 1,
  keywordIndex: 0,
};

export interface CaptionPanelProps {
  className?: string;
}

export function CaptionPanel({ className }: CaptionPanelProps) {
  const captionsEnabled = useRepurposeStore((s) => s.captionsEnabled);
  const captionStyle = useRepurposeStore((s) => s.captionStyle);
  const captionBlocks = useRepurposeStore((s) => s.captionBlocks);
  const setCaptionsEnabled = useRepurposeStore((s) => s.setCaptionsEnabled);
  const setCaptionTemplate = useRepurposeStore((s) => s.setCaptionTemplate);
  const patchCaptionStyle = useRepurposeStore((s) => s.patchCaptionStyle);
  const patchCaptionBlock = useRepurposeStore((s) => s.patchCaptionBlock);
  const setBlockPosition = useRepurposeStore((s) => s.setBlockPosition);
  const clearBlockPosition = useRepurposeStore((s) => s.clearBlockPosition);
  const editWordText = useRepurposeStore((s) => s.editWordText);
  const ensureCaptionBlocks = useRepurposeStore((s) => s.ensureCaptionBlocks);
  const selectedCaptionBlockId = useRepurposeStore((s) => s.selectedCaptionBlockId);
  const selectCaptionBlock = useRepurposeStore((s) => s.selectCaptionBlock);
  const words = useRepurposeStore((s) => s.words);
  // For the "edit the caption on screen" affordance: map the playhead to source
  // time, then pick the block the compositor is actually drawing at it (via the
  // shared activeCaptionBlockAt, so the panel and the render never disagree).
  const clips = useRepurposeStore((s) => s.clips);
  const playhead = useRepurposeStore((s) => s.playhead);
  const splitRatio = useRepurposeStore((s) => s.splitRatio);

  // SELF-REPAIR: whenever we have a transcript but no caption blocks (a project
  // loaded/restored via a path that never chunked), rebuild so captions are
  // never silently empty. Runs on mount and whenever `words` changes.
  useEffect(() => {
    ensureCaptionBlocks();
  }, [words, ensureCaptionBlocks]);

  // Fonts must be ready before tiles paint their real faces; flip a nonce to
  // force every tile to redraw once loadCaptionFonts() resolves.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let alive = true;
    loadCaptionFonts().then(() => {
      if (alive) setFontsReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Only one color popover open at a time.
  const [openSlot, setOpenSlot] = useState<ColorSlot | null>(null);

  const font = CAPTION_FONTS.find((f) => f.id === captionStyle.font) ?? CAPTION_FONTS[0];
  const sizePx1080 = Math.round(captionStyle.sizePct * 1080);
  const positionPct = Math.round(captionStyle.positionYPct * 100);
  // When pinned to the split, "Position" nudges the caption above/below the seam
  // (splitOffsetPct, roughly -0.1..+0.2 of height); the split handle itself sets
  // the base line, so dragging the face-cam carries the captions with it.
  const pinned = captionStyle.pinToSplit;
  const offsetPctLabel = `${captionStyle.splitOffsetPct >= 0 ? "+" : ""}${Math.round(
    captionStyle.splitOffsetPct * 100
  )}%`;

  const hasBlockOverrides = captionBlocks.some((b) => b.overrideStyle);

  const resetAllOverrides = () => {
    for (const b of captionBlocks) {
      if (b.overrideStyle) patchCaptionBlock(b.id, { overrideStyle: undefined });
    }
  };

  // The block currently SELECTED for per-block editing (may be null). Resolved
  // from the live blocks each render so it stays valid across ripple/undo (a
  // rebuild clears the selection in the store, so a dangling id never survives).
  const selectedBlock =
    selectedCaptionBlockId !== null
      ? captionBlocks.find((b) => b.id === selectedCaptionBlockId) ?? null
      : null;

  // The block the compositor is drawing at the playhead RIGHT NOW -- the target
  // of the "Edit caption at playhead" button. Same source-time -> block pick the
  // renderer uses (activeCaptionBlockAt over the playhead's source time), so the
  // Inspector always grabs the caption Manthan can see on the preview.
  const srcTAtPlayhead = timelineToSourceTime(clips, playhead);
  const blockOnScreen = activeCaptionBlockAt(captionBlocks, srcTAtPlayhead);

  // The selected block's live text per word (space-joined for one editable
  // string). Reading `textOverride ?? words[].text` mirrors how drawCaptions
  // resolves each word's shown text.
  const selectedWords: string[] = selectedBlock
    ? selectedBlock.words.map(
        (w, i) => selectedBlock.textOverride?.[i] ?? w.text
      )
    : [];
  const selectedText = selectedWords.join(" ");

  // The selected block's effective vertical position as an ABSOLUTE fraction of
  // output height (same 0..1 units setBlockPosition takes), so the per-scene
  // nudge slider reflects where THIS block actually sits.
  const selectedResolved = selectedBlock
    ? resolveBlockStyle(captionStyle, selectedBlock)
    : null;
  const selectedPositionYPct = selectedResolved
    ? selectedResolved.pinToSplit
      ? splitRatio + selectedResolved.splitOffsetPct
      : selectedResolved.positionYPct
    : 0.7;
  // Does THIS block carry a per-scene position override (vs. following global)?
  const selectedHasPositionOverride =
    selectedBlock?.overrideStyle !== undefined &&
    (selectedBlock.overrideStyle.positionYPct !== undefined ||
      selectedBlock.overrideStyle.splitOffsetPct !== undefined);

  // Commit a text edit: diff the typed words against the block's current shown
  // words and push each CHANGED slot through editWordText, which writes the
  // block's positional textOverride WITHOUT moving the cut. Word count is fixed
  // (fixing typos, not re-timing), so a word-count change is ignored.
  const commitSelectedText = (raw: string) => {
    if (!selectedBlock) return;
    const typed = raw.trim().split(/\s+/).filter((w) => w.length > 0);
    if (typed.length !== selectedBlock.words.length) return; // keep 1:1 mapping
    for (let i = 0; i < selectedBlock.words.length; i++) {
      const before = selectedWords[i];
      if (typed[i] === before) continue; // unchanged -- no edit, no history churn
      // editWordText resolves the raw word index by SOURCE start time; the
      // block's word carries the same start as the raw transcript word.
      const rawIndex = words.findIndex(
        (w) => Math.abs(w.start - selectedBlock.words[i].start) <= 1e-6
      );
      if (rawIndex !== -1) editWordText(rawIndex, typed[i]);
    }
  };

  return (
    <div className={`flex flex-col ${className ?? ""}`}>
      {/* 1. Header + master on/off toggle. */}
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Captions
        </h3>
        <button
          type="button"
          onClick={() => setCaptionsEnabled(!captionsEnabled)}
          title={captionsEnabled ? "Disable captions" : "Enable captions"}
          aria-pressed={captionsEnabled}
          className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
            captionsEnabled
              ? "border-[#FF6B35] text-[#FF6B35]"
              : "border-border text-muted-foreground hover:text-foreground"
          }`}
        >
          <Power size={13} weight="bold" />
          {captionsEnabled ? "On" : "Off"}
        </button>
      </div>

      {/* Everything below the master toggle dims + locks when captions are off. */}
      <div
        className={
          captionsEnabled ? "flex flex-col gap-5" : "pointer-events-none flex flex-col gap-5 opacity-50"
        }
        aria-disabled={!captionsEnabled}
      >
        {/* 2. Template gallery -- live-preview tiles. */}
        <Section label="Template">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {CAPTION_TEMPLATE_ORDER.map((id) => (
              <TemplateTile
                key={id}
                templateId={id}
                label={CAPTION_TEMPLATE_LABELS[id]}
                selected={captionStyle.template === id}
                fontsReady={fontsReady}
                onSelect={() => setCaptionTemplate(id)}
              />
            ))}
          </div>
        </Section>

        {/* 3. Font + weight + uppercase. */}
        <Section label="Font">
          <div className="flex flex-col gap-2">
            <select
              value={captionStyle.font}
              onChange={(e) =>
                patchCaptionStyle({ font: e.target.value as CaptionFontId })
              }
              className="w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground outline-none focus:border-[#FF6B35]"
            >
              {CAPTION_FONTS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-2">
              {font.weights.length > 1 && (
                <div className="flex items-center gap-1">
                  {font.weights.map((w) => {
                    const active = captionStyle.weight === w;
                    return (
                      <button
                        key={w}
                        type="button"
                        onClick={() => patchCaptionStyle({ weight: w })}
                        title={`Weight ${w}`}
                        className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                          active
                            ? "border-[#FF6B35] text-[#FF6B35]"
                            : "border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {w}
                      </button>
                    );
                  })}
                </div>
              )}

              <button
                type="button"
                onClick={() => patchCaptionStyle({ uppercase: !captionStyle.uppercase })}
                title="Toggle uppercase"
                aria-pressed={captionStyle.uppercase}
                className={`ml-auto flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                  captionStyle.uppercase
                    ? "border-[#FF6B35] text-[#FF6B35]"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                <TextAa size={13} weight="bold" />
                UPPER
              </button>
            </div>
          </div>
        </Section>

        {/* 4. Size + position sliders. */}
        <Section label="Layout">
          {/* Words per caption: 1 / 2 / 3 words on screen at a time. Drives the
              chunker's word budget; re-chunks blocks on change. Capped at 3 by
              the single-line + 3-word hard rules. */}
          <div className="flex items-center justify-between py-1">
            <span className="text-[11px] text-muted-foreground">Words per caption</span>
            <div className="flex items-center overflow-hidden rounded-md border border-border">
              {[1, 2, 3].map((n) => {
                const active = captionStyle.maxWordsPerLine === n;
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => patchCaptionStyle({ maxWordsPerLine: n })}
                    aria-pressed={active}
                    className={`px-2.5 py-1 text-[11px] font-medium tabular-nums transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {n}
                  </button>
                );
              })}
            </div>
          </div>
          <SliderRow
            label="Size"
            value={captionStyle.sizePct}
            min={0.03}
            max={0.12}
            step={0.001}
            display={`${sizePx1080}px`}
            onChange={(v) => patchCaptionStyle({ sizePct: v })}
          />
          {/* Pin-to-split toggle: when on, captions ride the split seam and the
              slider nudges them above/below it; when off, they sit at an absolute
              frame position. Pinned is the default split-screen Reel look. */}
          <div className="flex items-center justify-between py-1">
            <span className="text-[11px] text-muted-foreground">Pin to split</span>
            <button
              type="button"
              onClick={() => patchCaptionStyle({ pinToSplit: !pinned })}
              aria-pressed={pinned}
              className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                pinned
                  ? "border-[#FF6B35] text-[#FF6B35]"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {pinned ? "On" : "Off"}
            </button>
          </div>
          {pinned ? (
            <SliderRow
              label="Nudge"
              value={captionStyle.splitOffsetPct}
              min={-0.12}
              max={0.2}
              step={0.005}
              display={offsetPctLabel}
              onChange={(v) => patchCaptionStyle({ splitOffsetPct: v })}
            />
          ) : (
            <SliderRow
              label="Position"
              value={captionStyle.positionYPct}
              min={0.4}
              max={0.92}
              step={0.005}
              display={`${positionPct}%`}
              onChange={(v) => patchCaptionStyle({ positionYPct: v })}
            />
          )}
        </Section>

        {/* 5. Colors -- swatches + inline picker + stroke width. */}
        <Section label="Colors">
          <div className="grid grid-cols-2 gap-2">
            {COLOR_SLOTS.map(({ slot, label, nullable }) => (
              <ColorSwatch
                key={slot}
                label={label}
                value={captionStyle[slot] ?? ""}
                nullable={nullable}
                open={openSlot === slot}
                onToggle={() => setOpenSlot(openSlot === slot ? null : slot)}
                onChange={(v) => patchCaptionStyle({ [slot]: v } as Partial<CaptionStyle>)}
              />
            ))}
          </div>

          <div className="mt-3">
            <SliderRow
              label="Stroke width"
              value={captionStyle.strokeWidthPct}
              min={0}
              max={0.15}
              step={0.005}
              display={`${Math.round(captionStyle.strokeWidthPct * 100)}%`}
              onChange={(v) => patchCaptionStyle({ strokeWidthPct: v })}
            />
          </div>
        </Section>

        {/* 6. Animation + density. */}
        <Section label="Animation">
          <div className="flex flex-col gap-2">
            <select
              value={captionStyle.anim}
              onChange={(e) =>
                patchCaptionStyle({ anim: e.target.value as CaptionAnim })
              }
              className="w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs capitalize text-foreground outline-none focus:border-[#FF6B35]"
            >
              {ANIM_OPTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>

            <SliderRow
              label="Duration"
              value={captionStyle.animDurationMs}
              min={0}
              max={600}
              step={10}
              display={`${Math.round(captionStyle.animDurationMs)}ms`}
              onChange={(v) => patchCaptionStyle({ animDurationMs: Math.round(v) })}
            />

            {/* Word bounce: per-word SCALE-POP on the spoken word (the "every word
                punches" look). 0 = off; ~0.4 = a firm bounce. Applies on top of the
                block entrance -- pure transform in drawCaptions, so preview == export. */}
            <SliderRow
              label="Word bounce"
              value={captionStyle.activePop ?? 0}
              min={0}
              max={1}
              step={0.05}
              display={
                (captionStyle.activePop ?? 0) === 0
                  ? "Off"
                  : `${Math.round((captionStyle.activePop ?? 0) * 100)}%`
              }
              onChange={(v) => patchCaptionStyle({ activePop: v })}
            />

            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground">Density</span>
              <div className="ml-auto flex items-center gap-1">
                {(["tight", "normal"] as CaptionDensity[]).map((d) => {
                  const active = captionStyle.density === d;
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => patchCaptionStyle({ density: d })}
                      className={`rounded-md border px-2 py-1 text-[11px] font-medium capitalize transition-colors ${
                        active
                          ? "border-[#FF6B35] text-[#FF6B35]"
                          : "border-border text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </Section>

        {/* 7. Per-block editing -- select the caption on screen, then fix its text
            or nudge just THIS scene's captions up/down. Selection is transient
            (store-owned, out of undo history); a re-chunk auto-clears it. */}
        {captionBlocks.length > 0 && (
          <Section label="Selected block">
            <div className="flex flex-col gap-3">
              {/* Select the caption the preview is showing at the playhead. */}
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() =>
                    blockOnScreen && selectCaptionBlock(blockOnScreen.id)
                  }
                  disabled={!blockOnScreen}
                  title="Select the caption currently on screen at the playhead"
                  className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
                >
                  <CursorClick size={13} weight="bold" />
                  Edit caption at playhead
                </button>
                <button
                  type="button"
                  onClick={resetAllOverrides}
                  disabled={!hasBlockOverrides}
                  title="Clear every per-block override"
                  className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
                >
                  Reset all
                </button>
              </div>

              {selectedBlock ? (
                <BlockEditor
                  key={selectedBlock.id}
                  text={selectedText}
                  positionYPct={selectedPositionYPct}
                  hasPositionOverride={selectedHasPositionOverride}
                  onCommitText={commitSelectedText}
                  onNudge={(v) => setBlockPosition(selectedBlock.id, v)}
                  onClearPosition={() => clearBlockPosition(selectedBlock.id)}
                  onDeselect={() => selectCaptionBlock(null)}
                />
              ) : (
                <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
                  Move the playhead over a caption, then press{" "}
                  <span className="text-foreground">Edit caption at playhead</span>{" "}
                  to fix its wording or nudge just this scene up/down.
                </p>
              )}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper -- small uppercase label + body.
// ---------------------------------------------------------------------------
function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <span className="px-1 pb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BlockEditor -- the per-block edit surface for the SELECTED caption block:
//   - a text field bound to the block's shown words (fixes a transcription typo
//     via editWordText / textOverride, WITHOUT moving the cut). Held as local
//     draft state so typing is smooth; committed on blur / Enter, reverted on
//     Escape. Re-mounts (key=block id) whenever the selection changes, so the
//     draft reseeds from the newly-selected block.
//   - a per-scene vertical nudge (setBlockPosition) that leaves every other
//     scene on the global Position, plus a reset for just this block's position.
// All writes go through already-wired store methods; nothing here touches the
// cut, timing, or `words[]`.
// ---------------------------------------------------------------------------
function BlockEditor({
  text,
  positionYPct,
  hasPositionOverride,
  onCommitText,
  onNudge,
  onClearPosition,
  onDeselect,
}: {
  text: string;
  positionYPct: number;
  hasPositionOverride: boolean;
  onCommitText: (raw: string) => void;
  onNudge: (positionYPct: number) => void;
  onClearPosition: () => void;
  onDeselect: () => void;
}) {
  // Local draft so keystrokes don't round-trip through the store per character
  // (that would re-derive blocks and fight the caret). Commit on blur / Enter.
  const [draft, setDraft] = useState(text);
  // Reseed the draft when the bound text changes from OUTSIDE this field (a
  // different block selected, or an undo).
  useEffect(() => {
    setDraft(text);
  }, [text]);

  const commit = () => {
    if (draft !== text) onCommitText(draft);
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-[#FF6B35]/40 bg-card p-2.5">
      {/* Caption text -- fix a typo without moving the cut. */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">Caption text</span>
          <button
            type="button"
            onClick={onDeselect}
            title="Deselect this block"
            className="text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Done
          </button>
        </div>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(text); // revert the in-progress edit
              e.currentTarget.blur();
            }
          }}
          spellCheck={false}
          className="w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-xs text-foreground outline-none focus:border-[#FF6B35]"
        />
        <span className="px-0.5 text-[10px] leading-snug text-muted-foreground">
          Fixes wording only -- keep the same number of words; the cut and timing
          never move.
        </span>
      </div>

      {/* Per-scene vertical nudge -- only THIS block moves. */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            This scene position
          </span>
          <button
            type="button"
            onClick={onClearPosition}
            disabled={!hasPositionOverride}
            title="Revert this scene to the global caption position"
            className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
          >
            <ArrowUUpLeft size={12} weight="bold" />
            Reset
          </button>
        </div>
        <SliderRow
          label="Higher / lower"
          value={positionYPct}
          min={0.4}
          max={0.92}
          step={0.005}
          display={`${Math.round(positionYPct * 100)}%`}
          onChange={onNudge}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SliderRow -- native range styled with the coral accent + a value readout.
// ---------------------------------------------------------------------------
function SliderRow({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1 px-1 pb-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className="text-[11px] font-medium tabular-nums text-foreground">
          {display}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-[#FF6B35]"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ColorSwatch -- a color button that toggles an inline picker + quick-swatches.
// ---------------------------------------------------------------------------
function ColorSwatch({
  label,
  value,
  nullable,
  open,
  onToggle,
  onChange,
}: {
  label: string;
  value: string;
  nullable: boolean;
  open: boolean;
  onToggle: () => void;
  onChange: (v: string) => void;
}) {
  const isNone = value === "";
  // react-colorful only understands hex; strip rgba() defaults to a safe hex so
  // the picker still opens on a template that ships an rgba color.
  const pickerValue = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : "#FFFFFF";

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors ${
          open ? "border-[#FF6B35]" : "border-border hover:border-foreground/30"
        }`}
      >
        <span
          className="h-4 w-4 shrink-0 rounded-sm border border-border"
          style={
            isNone
              ? { backgroundImage: "linear-gradient(45deg,#888 25%,transparent 25%,transparent 75%,#888 75%)", backgroundSize: "6px 6px" }
              : { backgroundColor: value }
          }
        />
        <span className="text-[11px] text-muted-foreground">{label}</span>
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-card p-2">
          {/* Brand quick-swatch row -- one tap sets the open slot. */}
          <div className="flex flex-wrap gap-1.5">
            {QUICK_SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onChange(c)}
                title={c}
                className={`h-5 w-5 rounded-sm border transition-transform hover:scale-110 ${
                  value.toUpperCase() === c ? "border-[#FF6B35]" : "border-border"
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
            {nullable && (
              <button
                type="button"
                onClick={() => onChange("")}
                title="None"
                aria-pressed={isNone}
                className={`flex h-5 w-5 items-center justify-center rounded-sm border transition-colors ${
                  isNone ? "border-[#FF6B35] text-[#FF6B35]" : "border-border text-muted-foreground"
                }`}
              >
                <Prohibit size={12} weight="bold" />
              </button>
            )}
          </div>

          <HexColorPicker
            color={pickerValue}
            onChange={onChange}
            style={{ width: "100%", height: 110 }}
          />
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-muted-foreground">#</span>
            <HexColorInput
              color={pickerValue}
              onChange={onChange}
              className="w-full rounded-md border border-border bg-secondary px-2 py-1 text-[11px] uppercase text-foreground outline-none focus:border-[#FF6B35]"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TemplateTile -- DPR-correct <canvas> rendering a LIVE drawCaptions sample.
// ---------------------------------------------------------------------------
function TemplateTile({
  templateId,
  label,
  selected,
  fontsReady,
  onSelect,
}: {
  templateId: CaptionTemplateId;
  label: string;
  selected: boolean;
  fontsReady: boolean;
  onSelect: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Redraw when the template changes or fonts become ready (so real faces show
  // instead of the fallback the first paint may have used).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(TILE_W * dpr);
    canvas.height = Math.round(TILE_H * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Dark gradient backdrop so light caption text reads (mimics footage).
    const bg = ctx.createLinearGradient(0, 0, 0, TILE_H);
    bg.addColorStop(0, "#1c1c22");
    bg.addColorStop(1, "#0b0b0c");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, TILE_W, TILE_H);

    // A LIVE sample of the caption template, drawn through the real renderer so
    // the tile shows the actual look (stroke, pill, color) at output scale.
    drawCaptions(ctx, {
      style: CAPTION_TEMPLATES[templateId],
      blocks: [PREVIEW_BLOCK],
      srcT: 0.5,
      width: TILE_W,
      height: TILE_H,
      // Center the sample in the tile: pinned templates anchor to this "split".
      splitRatio: 0.5 - CAPTION_TEMPLATES[templateId].splitOffsetPct,
    });
  }, [templateId, fontsReady]);

  return (
    <button
      type="button"
      onClick={onSelect}
      title={label}
      className="flex shrink-0 flex-col items-center gap-1"
    >
      <div
        className={`overflow-hidden rounded-lg ${
          selected ? "ring-2 ring-[#FF6B35]" : "ring-1 ring-border"
        }`}
        style={{ width: TILE_W, height: TILE_H }}
      >
        <canvas
          ref={canvasRef}
          className="h-full w-full"
          style={{ width: TILE_W, height: TILE_H }}
        />
      </div>
      <span
        className={`text-[11px] ${
          selected ? "font-medium text-[#FF6B35]" : "text-muted-foreground"
        }`}
      >
        {label}
      </span>
    </button>
  );
}
