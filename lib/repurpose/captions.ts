// ===========================================================================
// REPURPOSE STUDIO -- caption system (types, templates, chunking, renderer)
// ===========================================================================
// Burned-in word-level captions for the vertical Reel. This is the single
// contract file the preview, the export, the store, and the Inspector panel all
// build against -- mirroring how color-grade.ts + compositor.ts relate.
//
// DRAW MODEL. `drawCaptions(ctx, opts)` is a PURE Canvas 2D function called
// AFTER `drawFrame` in the same render pass, in BOTH:
//   - PreviewCanvas's rAF loop (live), and
//   - export-short's frame loop (burns into the MP4).
// So "what you see is what you export." It never touches the DOM and takes only
// the data it needs.
//
// TIME MODEL. Word.start/end are SOURCE seconds; the playhead is OUTPUT seconds.
// The caller converts once per frame via timelineToSourceTime(clips, playhead)
// and passes the resulting `srcT` in. A word is active/visible based on srcT vs
// its start/end, so captions stay glued to their words across retake
// trims/reorders -- the exact property the pan/zoom keyframe remap guarantees.
//
// SIZING. Every dimension is a FRACTION of output width/height, multiplied by
// the real output size once at draw time, so preview (1080) and export (1080 or
// 4K) render identically.
//
// SHADOW SAFETY. This project bans ctx.shadowBlur inside animation loops (OOM,
// memory feedback_no_shadowblur_in_loops.md). drawCaptions NEVER sets
// shadowBlur. Depth comes from a thick strokeText outline and/or a hard offset
// double-draw (a blur-free fake drop shadow). A soft rasterized-sprite shadow is
// a possible later enhancement but is intentionally out of the hot path here.
// ===========================================================================

import type { Word } from "./types";
import { captionFontString, type CaptionFontId } from "./caption-fonts";
import { easings } from "../engine/easing";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CaptionTemplateId =
  | "word-pop"
  | "beast-bounce"
  | "karaoke-wipe"
  | "highlight-box"
  | "clean-minimal"
  | "bold-outline"
  | "clawd-hop"
  | "clawd-peek"
  | "underline-hold"
  | "single-punch"
  | "gradient-pop"
  | "typewriter"
  | "two-tone-stack";

export type CaptionAnim =
  | "none"
  | "fade"
  | "pop"
  | "spring"
  | "wipe"
  | "punch"
  | "type"; // typewriter: per-character reveal with a blinking caret

/** How aggressively to chunk words into on-screen blocks. */
export type CaptionDensity = "tight" | "normal"; // tight = 1-2 words, normal = 2-3+

/**
 * A fully-resolved caption style. Every field is required at draw time; a
 * template is just a named preset of this shape, and a per-block override is a
 * Partial<CaptionStyle> shallow-merged on top.
 */
export interface CaptionStyle {
  template: CaptionTemplateId;
  font: CaptionFontId;
  weight: number; // 400..900, clamped to the font's shipped weights at draw
  /** Text size as a fraction of output WIDTH (e.g. 0.083 -> ~90px @1080). */
  sizePct: number;
  uppercase: boolean;
  /** Letter spacing as a fraction of size (e.g. -0.02). */
  letterSpacingPct: number;
  /** Line spacing as a fraction of size for multi-line blocks (e.g. 1.12). */
  lineHeightMul: number;
  fill: string; // idle word color
  activeFill: string; // spoken/keyword color
  strokeColor: string; // "" = no stroke
  /** Stroke width as a fraction of size (e.g. 0.11 -> ~10px on 90px text). */
  strokeWidthPct: number;
  /** Hard offset drop shadow (blur-free, loop-safe). "" = none. */
  shadowColor: string;
  /** Backing box / active-word pill fill. "" = none. rgba ok. */
  boxColor: string;
  /**
   * Soft glow halo color behind the glyph (Solo's coral bloom). "" = none.
   * Rendered as a loop-safe layered translucent stroke expanding outward -- NEVER
   * ctx.shadowBlur (banned in loops). rgba recommended so the halo reads as a soft
   * bloom.
   */
  glowColor?: string;
  /**
   * Active-word SCALE-POP: each word gives a short spring bounce the instant it is
   * spoken (the "every word punches" viral look). 0 / undefined = off. ~0.4 = a
   * firm bounce (the spoken glyph peaks ~40% larger then settles to 1). Applied as
   * a pure transform scale about the glyph's own center inside the per-word draw --
   * blur-free + loop-safe, so it renders IDENTICALLY in preview and export. Layers
   * on top of any block-level entrance (Beast/Word-Pop pop the phrase together;
   * this adds a per-word micro-bounce as narration sweeps across the line).
   */
  activePop?: number;
  /**
   * Vertical gradient fill for the glyph (Gradient Pop). When set, the word is
   * filled with a top->bottom linearGradient from gradientFrom to gradientTo
   * instead of the flat `fill`. "" / undefined = flat fill. The active/spoken word
   * still overrides to `activeFill` (flat) so the accent reads.
   */
  gradientFrom?: string;
  gradientTo?: string;
  /**
   * Second-line color for two-tone stacked styles (Two-Tone Stack). When set and
   * the block wraps to 2 lines, line 2 uses this color instead of `fill`. ""/undef
   * = both lines use `fill`.
   */
  secondLineFill?: string;
  /**
   * Underline Hold: the bright gliding underline segment color (the karaoke
   * accent that travels to the active word). "" / undefined = no underline.
   */
  underlineColor?: string;
  /**
   * Underline Hold: the steady dim rail drawn under the whole phrase (the track
   * the bright segment glides along). "" / undefined = no rail (segment only).
   */
  underlineRailColor?: string;
  /** Box corner radius as a fraction of line height. */
  boxRadiusPct: number;
  /** Box padding X/Y as a fraction of size. */
  boxPadXPct: number;
  boxPadYPct: number;
  /**
   * When true, captions are PINNED to the split line (the orange handle between
   * the screen + face halves) instead of a fixed frame position -- so dragging
   * the split up/down carries the captions with it. This is the default look for
   * a split-screen Reel: the words sit right at the seam. `splitOffsetPct` nudges
   * them above (-) or below (+) the seam as a fraction of output height.
   * When false, `positionYPct` is used as an absolute anchor.
   */
  pinToSplit: boolean;
  /** Offset from the split line when pinned, as a fraction of output HEIGHT (+ = below). */
  splitOffsetPct: number;
  /** Vertical baseline anchor as a fraction of output HEIGHT (0..1). Used when pinToSplit is false. */
  positionYPct: number;
  maxWordsPerLine: number;
  maxCharsPerLine: number;
  maxLines: number;
  /** Chunk density used when (re)building blocks. */
  density: CaptionDensity;
  anim: CaptionAnim;
  animDurationMs: number;
}

/**
 * One caption block = one line/phrase group shown on screen together, carrying
 * its own word timings (SOURCE seconds) so it can highlight word-by-word.
 */
export interface CaptionBlock {
  id: string;
  words: Word[];
  start: number; // = words[0].start (cached)
  end: number; // = last word end (cached)
  /** Per-block style overrides on top of the global style. */
  overrideStyle?: Partial<CaptionStyle>;
  /** Word index to accent as the keyword (Word Pop). -1/undefined = none. */
  keywordIndex?: number;
  /** Optional manual text override per word (fix a transcription typo). */
  textOverride?: string[];
}

// ---------------------------------------------------------------------------
// Templates -- named CaptionStyle presets. Recipes from the research dossier.
// ---------------------------------------------------------------------------

/** Shared defaults so each template only states what differs. */
const BASE: CaptionStyle = {
  template: "bold-outline",
  font: "tiktokDisplay",
  weight: 700,
  sizePct: 0.065,
  uppercase: true,
  letterSpacingPct: 0,
  lineHeightMul: 1.12,
  fill: "#FFFFFF",
  activeFill: "#FFD93D",
  strokeColor: "#000000",
  strokeWidthPct: 0.08,
  shadowColor: "",
  boxColor: "",
  boxRadiusPct: 0.35,
  boxPadXPct: 0.22,
  boxPadYPct: 0.12,
  // Default: pinned to the split seam, centered EXACTLY on the coral handle.
  // Drag the split -> captions follow. splitOffsetPct nudges above (-)/below (+)
  // the seam; 0 = dead center on the handle (the layout centers the text on the
  // anchor line, so the caption straddles the seam).
  pinToSplit: true,
  splitOffsetPct: 0,
  positionYPct: 0.7,
  maxWordsPerLine: 2,
  maxCharsPerLine: 22,
  maxLines: 1,
  density: "normal",
  anim: "fade",
  animDurationMs: 140,
};

export const CAPTION_TEMPLATES: Record<CaptionTemplateId, CaptionStyle> = {
  // A -- Word Pop (Hormozi): 1-3 huge all-caps words, thick outline, keyword yellow.
  "word-pop": {
    ...BASE,
    template: "word-pop",
    font: "anton",
    weight: 400,
    sizePct: 0.093,
    uppercase: true,
    letterSpacingPct: -0.01,
    fill: "#FFFFFF",
    activeFill: "#FFD93D",
    strokeColor: "#000000",
    strokeWidthPct: 0.1,
    shadowColor: "rgba(0,0,0,0.35)",
    positionYPct: 0.66,
    maxWordsPerLine: 2,
    maxCharsPerLine: 18,
    maxLines: 1,
    density: "normal",
    anim: "pop",
    animDurationMs: 220,
  },
  // B -- Beast Bounce (MrBeast): phrase pops together with a spring overshoot.
  "beast-bounce": {
    ...BASE,
    template: "beast-bounce",
    font: "tiktokDisplay",
    weight: 700,
    sizePct: 0.083,
    uppercase: true,
    fill: "#FFFFFF",
    activeFill: "#FFD93D",
    strokeColor: "#0A0A2A",
    strokeWidthPct: 0.06,
    shadowColor: "rgba(0,0,0,0.4)",
    positionYPct: 0.6,
    maxWordsPerLine: 2,
    maxCharsPerLine: 20,
    maxLines: 1,
    density: "normal",
    anim: "spring",
    animDurationMs: 340,
  },
  // C -- Karaoke Wipe: full line, active word color-fills left-to-right.
  "karaoke-wipe": {
    ...BASE,
    template: "karaoke-wipe",
    font: "tiktokText",
    weight: 700,
    sizePct: 0.058,
    uppercase: false,
    fill: "rgba(255,255,255,0.55)",
    activeFill: "#00d4aa",
    strokeColor: "#000000",
    strokeWidthPct: 0.05,
    positionYPct: 0.7,
    maxWordsPerLine: 2,
    maxCharsPerLine: 36,
    maxLines: 1,
    density: "normal",
    anim: "wipe",
    animDurationMs: 0,
  },
  // D -- Highlight Box (CapCut): active word sits in a coral pill.
  "highlight-box": {
    ...BASE,
    template: "highlight-box",
    font: "tiktokSans",
    weight: 400,
    sizePct: 0.056,
    uppercase: true,
    fill: "#FFFFFF",
    activeFill: "#000000",
    strokeColor: "",
    strokeWidthPct: 0,
    boxColor: "#FF6B35",
    boxRadiusPct: 0.32,
    boxPadXPct: 0.24,
    boxPadYPct: 0.14,
    positionYPct: 0.71,
    maxWordsPerLine: 2,
    maxCharsPerLine: 22,
    maxLines: 1,
    density: "normal",
    anim: "pop",
    animDurationMs: 140,
  },
  // E -- Clean Minimal: understated, backing box, sentence case, low third.
  "clean-minimal": {
    ...BASE,
    template: "clean-minimal",
    font: "tiktokText",
    weight: 500,
    sizePct: 0.045,
    uppercase: false,
    fill: "#FFFFFF",
    activeFill: "#FFFFFF",
    strokeColor: "",
    strokeWidthPct: 0,
    boxColor: "rgba(11,11,12,0.55)",
    boxRadiusPct: 0.25,
    boxPadXPct: 0.3,
    boxPadYPct: 0.2,
    shadowColor: "rgba(0,0,0,0.5)",
    positionYPct: 0.8,
    maxWordsPerLine: 2,
    maxCharsPerLine: 40,
    maxLines: 1,
    density: "normal",
    anim: "fade",
    animDurationMs: 150,
  },
  // F -- Bold Outline: the universal safe default (== BASE with UPPER + outline).
  "bold-outline": {
    ...BASE,
    template: "bold-outline",
    font: "tiktokDisplay",
    weight: 700,
    sizePct: 0.066,
    uppercase: true,
    fill: "#FFFFFF",
    activeFill: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidthPct: 0.09,
    positionYPct: 0.7,
    maxWordsPerLine: 2,
    maxCharsPerLine: 24,
    maxLines: 1,
    density: "normal",
    anim: "fade",
    animDurationMs: 120,
  },
  // F2 -- Clawd Hop: the Bold Outline look EXACTLY (white TikTok Display caps,
  // black outline) with ONE pixel Clawd mascot in the official Claude color
  // (#CD7B5A) perched above the line, HOPPING word -> word (1->2->3) as each is
  // spoken. One mascot per block; every new block picks a deterministically
  // "random" expression so consecutive lines feel unique. Mascot draw is
  // blur-free + loop-safe (grid fillRects, no shadowBlur), so preview == export.
  "clawd-hop": {
    ...BASE,
    template: "clawd-hop",
    font: "tiktokDisplay",
    weight: 700,
    sizePct: 0.066,
    uppercase: true,
    fill: "#FFFFFF",
    activeFill: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidthPct: 0.09,
    positionYPct: 0.7,
    // Up to 3 words on the line so the mascot has a proper 1->2->3 hop path.
    maxWordsPerLine: 3,
    maxCharsPerLine: 26,
    maxLines: 1,
    density: "normal",
    // Words themselves fade in (matching Bold); the mascot hop is its own motion.
    anim: "fade",
    animDurationMs: 120,
  },
  // F2b -- Clawd Peek: the Bold look with ONE Claude-color mascot that HIDES behind
  // the words and PEEKS up over whichever word is being spoken, ducking back down
  // as narration moves on. Playful + mascot-forward. Distinct from Clawd Hop (which
  // rides ABOVE the line and jumps between words) -- here Clawd pops up from behind
  // the caption itself. Blur-free grid sprite, loop-safe (preview == export).
  "clawd-peek": {
    ...BASE,
    template: "clawd-peek",
    font: "tiktokDisplay",
    weight: 700,
    sizePct: 0.066,
    uppercase: true,
    fill: "#FFFFFF",
    activeFill: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidthPct: 0.09,
    positionYPct: 0.7,
    maxWordsPerLine: 3,
    maxCharsPerLine: 26,
    maxLines: 1,
    density: "normal",
    // Text is stable (Bold); the peek is the motion.
    anim: "none",
    animDurationMs: 0,
  },
  // F3 -- Underline Hold: the Bold look with a KARAOKE underline tuned for FAST
  // speech. A steady dim rail sits under the whole phrase; a single bright lime
  // segment GLIDES to whichever word is being spoken -- it never redraws per word
  // (a redrawing/sweeping underline strobes at 4 words/sec). The text stays fully
  // stable + readable; only the bright segment moves, smoothly, so the eye
  // follows one calm thing. Blur-free + loop-safe.
  "underline-hold": {
    ...BASE,
    template: "underline-hold",
    font: "tiktokDisplay",
    weight: 700,
    sizePct: 0.066,
    uppercase: true,
    fill: "#FFFFFF",
    activeFill: "#FFFFFF", // text does NOT change color; the underline is the accent
    strokeColor: "#000000",
    strokeWidthPct: 0.09,
    underlineColor: "#9CFF1E", // bright gliding segment (brand lime)
    underlineRailColor: "rgba(156,255,30,0.26)", // steady dim rail under the phrase
    positionYPct: 0.7,
    maxWordsPerLine: 3,
    maxCharsPerLine: 26,
    maxLines: 1,
    density: "normal",
    // Text is instantly stable (no fade smear); the motion is the gliding segment.
    anim: "none",
    animDurationMs: 0,
  },
  // G -- Solo (single word): ONE big word on screen at a time, spring-punches in
  // and settles, soft neon glow on the spoken word. The dominant 2025-2026
  // "TikTok Sans single-word" look. Distinct from Word Pop (2-3 words) and Beast
  // (a whole phrase pops together): here each word appears alone, in sequence.
  "single-punch": {
    ...BASE,
    template: "single-punch",
    font: "tiktokDisplay",
    weight: 700,
    sizePct: 0.115, // huge -- it owns the frame alone
    uppercase: true,
    letterSpacingPct: -0.01,
    fill: "#FFFFFF",
    activeFill: "#FFFFFF",
    strokeColor: "#0A0A14",
    strokeWidthPct: 0.055,
    shadowColor: "",
    glowColor: "rgba(255,107,53,0.55)", // coral bloom (#FF6B35)
    positionYPct: 0.62,
    maxWordsPerLine: 1, // <- one word per block: the chunker makes solo blocks
    maxCharsPerLine: 14,
    maxLines: 1,
    density: "tight",
    anim: "punch",
    animDurationMs: 300,
  },
  // H -- Gradient Pop: heavy Anton caps filled with a top->bottom gold->coral
  // gradient (brand palette), warm near-black outline. Spoken word flips to white.
  "gradient-pop": {
    ...BASE,
    template: "gradient-pop",
    font: "anton",
    weight: 400,
    sizePct: 0.094,
    uppercase: true,
    letterSpacingPct: 0.005,
    fill: "#FF8A4C",
    activeFill: "#FFFFFF",
    strokeColor: "#1A0E06",
    strokeWidthPct: 0.011,
    gradientFrom: "#FFD93D", // top (gold)
    gradientTo: "#FF6B35", // bottom (coral)
    positionYPct: 0.6,
    maxWordsPerLine: 2,
    maxCharsPerLine: 22,
    maxLines: 1,
    density: "normal",
    anim: "pop",
    animDurationMs: 240,
  },
  // J -- Typewriter: teletype per-character reveal with a blinking teal caret on a
  // dark terminal box. Off-white body, brand-teal on the word being typed.
  "typewriter": {
    ...BASE,
    template: "typewriter",
    font: "dmSans",
    weight: 600,
    sizePct: 0.058,
    uppercase: false,
    letterSpacingPct: 0.03,
    fill: "#F5F5F0",
    activeFill: "#00d4aa",
    strokeColor: "",
    strokeWidthPct: 0,
    boxColor: "rgba(14,16,18,0.82)",
    boxRadiusPct: 0.22,
    boxPadXPct: 0.34,
    boxPadYPct: 0.22,
    positionYPct: 0.7,
    maxWordsPerLine: 3,
    maxCharsPerLine: 34,
    maxLines: 1,
    density: "normal",
    anim: "type",
    animDurationMs: 400, // caret blink half-period basis
  },
  // K -- Two-Tone Stack: two words stacked, line 1 white / line 2 coral, huge
  // condensed Anton caps. Spoken word flashes gold. The "Bold Duo" / Hormozi stack.
  "two-tone-stack": {
    ...BASE,
    template: "two-tone-stack",
    font: "anton",
    weight: 400,
    sizePct: 0.115,
    uppercase: true,
    letterSpacingPct: -0.015,
    lineHeightMul: 0.98,
    fill: "#FFFFFF", // line 1
    secondLineFill: "#FF6B35", // line 2 (brand coral)
    activeFill: "#FFD93D", // spoken word (gold)
    strokeColor: "#0A0A0A",
    strokeWidthPct: 0.011,
    positionYPct: 0.58,
    maxWordsPerLine: 1, // one word per line -> two words stack
    maxCharsPerLine: 12,
    maxLines: 2,
    density: "tight",
    anim: "pop",
    animDurationMs: 180,
  },
};

/** All templates in display order (Word Pop first -- the default). */
export const CAPTION_TEMPLATE_ORDER: CaptionTemplateId[] = [
  "word-pop",
  "single-punch",
  "gradient-pop",
  "two-tone-stack",
  "typewriter",
  "highlight-box",
  "bold-outline",
  "clawd-hop",
  "clawd-peek",
  "underline-hold",
  "beast-bounce",
  "karaoke-wipe",
  "clean-minimal",
];

/** Human labels for the picker. */
export const CAPTION_TEMPLATE_LABELS: Record<CaptionTemplateId, string> = {
  "word-pop": "Word Pop",
  "single-punch": "Solo",
  "gradient-pop": "Gradient",
  "two-tone-stack": "Stack",
  "typewriter": "Typewriter",
  "highlight-box": "Highlight",
  "bold-outline": "Bold",
  "clawd-hop": "Clawd",
  "clawd-peek": "Peek",
  "underline-hold": "Underline",
  "beast-bounce": "Beast",
  "karaoke-wipe": "Karaoke",
  "clean-minimal": "Minimal",
};

/** The default global style a fresh project starts with. */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = CAPTION_TEMPLATES["word-pop"];

/** Resolve a block's effective style: global <- block override (shallow merge). */
export function resolveBlockStyle(
  global: CaptionStyle,
  block: CaptionBlock
): CaptionStyle {
  return block.overrideStyle ? { ...global, ...block.overrideStyle } : global;
}

/**
 * The caption block on screen at SOURCE time `srcT`, or null. This is the SAME
 * pick drawCaptions makes for what it paints -- a strict [start, end] containment
 * match first (so back-to-back blocks resolve to the one being spoken), then a
 * small LEAD-padded window for a block a hair before/after its word timings. It
 * is exported so the Inspector's "edit the caption on screen" affordance targets
 * EXACTLY the block the compositor is drawing, and the two can never disagree.
 */
export function activeCaptionBlockAt(
  blocks: readonly CaptionBlock[],
  srcT: number | null
): CaptionBlock | null {
  if (srcT === null || blocks.length === 0) return null;
  const LEAD = 0.05; // keep drawCaptions' entrance/exit padding identical
  for (const b of blocks) {
    if (srcT >= b.start && srcT <= b.end) return b;
  }
  for (const b of blocks) {
    if (srcT >= b.start - LEAD && srcT <= b.end + LEAD) return b;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chunking -- Word[] -> CaptionBlock[]
// ---------------------------------------------------------------------------

const SENTENCE_END = /[.!?]$/;
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for",
  "is", "it", "so", "as", "i", "you", "we", "they", "he", "she", "that", "this",
  "with", "my", "your", "our", "was", "are", "be", "if", "do", "just",
]);

/** Pause-gap (sec) that forces a new block. Tight density chunks more eagerly. */
function pauseGapFor(density: CaptionDensity): number {
  return density === "tight" ? 0.35 : 0.6;
}

// HARD RULE: captions are ALWAYS a single line. Never two lines. We clamp
// maxLines to this everywhere it's used (chunk budgets + layout wrap) so no
// template default, per-block override, or restored/stale style can ever
// produce a two-line caption. Changing this to >1 is a deliberate rule change.
const MAX_CAPTION_LINES = 1;

// HARD RULE: a caption block is AT MOST 3 words (2-3 words on screen at a time).
// This is the ceiling regardless of a style's maxWordsPerLine, so no template or
// override can ever push a longer phrase on screen.
const MAX_CAPTION_WORDS = 3;

/**
 * Effective line cap for a style, clamped to the single-line hard rule.
 * EXCEPTION: Two-Tone Stack is the one style that deliberately stacks words onto
 * two lines (line 1 white / line 2 accent), so it is allowed up to 2 lines.
 */
function effectiveMaxLines(style: CaptionStyle): number {
  const hardCap = style.template === "two-tone-stack" ? 2 : MAX_CAPTION_LINES;
  return Math.min(hardCap, Math.max(1, style.maxLines));
}

/**
 * Words per caption block. `maxWordsPerLine` is the explicit user control
 * (1 / 2 / 3 words), clamped to [1, MAX_CAPTION_WORDS] so it can never exceed
 * the 3-word hard cap. This is the single source of truth for words-per-caption.
 * EXCEPTION: Two-Tone Stack fits `maxWordsPerLine` words on EACH of its (up to 2)
 * lines, so its per-block budget is words-per-line * line-count.
 */
function wordBudgetFor(style: CaptionStyle): number {
  const perLine = Math.max(1, Math.round(style.maxWordsPerLine));
  const budget =
    style.template === "two-tone-stack" ? perLine * effectiveMaxLines(style) : perLine;
  return Math.min(MAX_CAPTION_WORDS, budget);
}

/** Pick the keyword index within a block: longest non-stopword, else last word. */
function pickKeyword(words: Word[]): number {
  let best = -1;
  let bestLen = 0;
  words.forEach((w, i) => {
    const clean = w.text.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (clean.length > bestLen && !STOPWORDS.has(clean)) {
      best = i;
      bestLen = clean.length;
    }
  });
  return best >= 0 ? best : words.length - 1;
}

/**
 * Group a word-level transcript into on-screen caption blocks. A new block
 * starts on: a pause gap, a sentence end, the char budget, or the word budget --
 * whichever hits first. Chunking depends on the active style (density + budgets),
 * so re-run this when the template/density changes.
 */
export function chunkWordsIntoBlocks(
  words: readonly Word[],
  style: CaptionStyle
): CaptionBlock[] {
  if (words.length === 0) return [];
  const blocks: CaptionBlock[] = [];
  const gap = pauseGapFor(style.density);
  const wordBudget = wordBudgetFor(style);
  // Single-line hard rule: char budget is per-line * clamped line count (=1).
  // Floor it so the WORD cap (2-3 words) is what actually bounds a block, not a
  // too-tight char budget that would split a legit 3-word phrase early
  // (~10 chars/word covers "automation for" etc.).
  const charBudget = Math.max(
    MAX_CAPTION_WORDS * 10,
    style.maxCharsPerLine * effectiveMaxLines(style)
  );

  let buf: Word[] = [];
  let chars = 0;
  let idx = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const w = buf;
    blocks.push({
      id: `cap-${idx++}-${Math.round(w[0].start * 1000)}`,
      words: w,
      start: w[0].start,
      end: w[w.length - 1].end,
      keywordIndex: pickKeyword(w),
    });
    buf = [];
    chars = 0;
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const prev = buf[buf.length - 1];
    const wordChars = word.text.length + 1;

    // Boundary BEFORE adding: a pause since the previous word closes the block.
    if (prev && word.start - prev.end > gap) flush();
    // Char/word budget would overflow -> close first.
    if (buf.length > 0 && (chars + wordChars > charBudget || buf.length >= wordBudget)) {
      flush();
    }

    buf.push(word);
    chars += wordChars;

    // Boundary AFTER adding: a sentence-ending token closes the block.
    if (SENTENCE_END.test(word.text.trim())) flush();
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/** A word laid out on a line, with its measured metrics. */
interface LaidWord {
  text: string;
  wordIndex: number; // index into block.words
  x: number; // left edge, logical px
  width: number;
}

interface LaidLine {
  words: LaidWord[];
  width: number;
  y: number; // baseline, logical px
}

/** True when the token is (likely) a single emoji -- skip stroke on these. */
function isEmoji(token: string): boolean {
  // Rough but effective: any non-ASCII pictographic char.
  return /\p{Extended_Pictographic}/u.test(token);
}

// Horizontal margins. Captions must fit inside the SAFE zone; they are NEVER
// allowed past the DANGER zone even at the min auto-fit scale. Both are fractions
// of output width (symmetric left/right). safe 0.86 -> 7% margin each side.
const SAFE_ZONE_W = 0.86;
const DANGER_ZONE_W = 0.92;
// Auto-fit floor: never shrink a block below this fraction of its nominal size
// (keeps captions punchy). Only a single very long word can bottom this out, in
// which case it may sit between the safe and danger lines but never past danger.
const MIN_FIT_SCALE = 0.68;

/**
 * Measure + wrap a block's visible words into centered lines, AUTO-FITTING the
 * font down so the widest line never crosses the safe zone (and never the danger
 * zone). Returns the laid-out lines AND the effective `sizePx` actually used, so
 * the renderer scales stroke / spacing / boxes / the Clawd mascot to match.
 *
 * `ctx.font` must be set to the block's font at the NOMINAL `sizePx` on entry;
 * this fn may re-set it to the fitted size and leaves it at the fitted size.
 */
function layoutBlock(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  block: CaptionBlock,
  style: CaptionStyle,
  sizePx: number,
  width: number,
  baselineY: number,
  setFont: (px: number) => void
): { lines: LaidLine[]; sizePx: number } {
  const texts = block.words.map((w, i) => {
    let t = block.textOverride?.[i] ?? w.text;
    if (style.uppercase) t = t.toUpperCase();
    return t;
  });
  const maxLines = effectiveMaxLines(style);

  // Wrap + measure the block at a given size. Returns the raw (pre-centering)
  // lines and the widest line width so we can decide whether to shrink.
  const layoutAt = (px: number) => {
    setFont(px);
    const letterSpacing = style.letterSpacingPct * px;
    const measure = (t: string) => {
      const base = ctx.measureText(t).width;
      return base + Math.max(0, t.length - 1) * letterSpacing;
    };
    const spaceW = measure(" ");
    const lines: { words: LaidWord[]; width: number }[] = [];
    let cur: LaidWord[] = [];
    let curW = 0;
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      const w = measure(t);
      const addW = cur.length === 0 ? w : curW + spaceW + w;
      if (
        cur.length > 0 &&
        (addW > width * SAFE_ZONE_W || cur.length >= style.maxWordsPerLine) &&
        lines.length < maxLines - 1
      ) {
        lines.push({ words: cur, width: curW });
        cur = [];
        curW = 0;
      }
      const x = cur.length === 0 ? 0 : curW + spaceW;
      cur.push({ text: t, wordIndex: i, x, width: w });
      curW = cur.length === 1 ? w : curW + spaceW + w;
    }
    if (cur.length > 0) lines.push({ words: cur, width: curW });
    const widest = lines.reduce((m, l) => Math.max(m, l.width), 0);
    return { lines, widest };
  };

  // First pass at nominal size. If it already fits the safe zone, we're done at
  // full size (the common case -- looks exactly as before). Otherwise shrink by
  // the exact ratio that lands the widest line ON the safe zone, clamped to the
  // fit floor, then never let the result exceed the danger zone.
  let laid = layoutAt(sizePx);
  let fitted = sizePx;
  const safeW = width * SAFE_ZONE_W;
  if (laid.widest > safeW) {
    const scale = Math.max(MIN_FIT_SCALE, safeW / laid.widest);
    fitted = sizePx * scale;
    laid = layoutAt(fitted);
    // Hard guard: if the fit floor still leaves it past the danger zone (a lone
    // enormous word), squeeze the rest of the way to the danger line -- fitting
    // the frame beats staying "punchy" when they conflict.
    const dangerW = width * DANGER_ZONE_W;
    if (laid.widest > dangerW) {
      fitted = fitted * (dangerW / laid.widest);
      laid = layoutAt(fitted);
    }
  }

  const lineHeight = style.lineHeightMul * fitted;

  // Vertically center the text ON baselineY (the caption's anchor -- e.g. the
  // split seam) using REAL font metrics, not an approximation. measureText gives
  // the actual ascent/descent of the glyphs; the vertical midpoint of the drawn
  // glyphs sits (ascent - descent)/2 ABOVE the baseline. Placing the baseline
  // that much below the anchor lands the glyphs' true visual middle exactly on
  // the anchor line, so a pinned caption straddles the coral handle dead-center.
  const probe = ctx.measureText("Ag"); // caps + descender = full vertical extent (font is at fitted size)
  const ascent = probe.actualBoundingBoxAscent || fitted * 0.72;
  const descent = probe.actualBoundingBoxDescent || fitted * 0.2;
  const glyphCenterAboveBaseline = (ascent - descent) / 2;
  const totalH = laid.lines.length * lineHeight;
  const firstLineCenter = baselineY - totalH / 2 + lineHeight * 0.5;
  const firstBaseline = firstLineCenter + glyphCenterAboveBaseline;

  const lines = laid.lines.map((line, li) => {
    const startX = (width - line.width) / 2;
    const y = firstBaseline + li * lineHeight;
    return {
      width: line.width,
      y,
      words: line.words.map((lw) => ({ ...lw, x: startX + lw.x })),
    };
  });
  return { lines, sizePx: fitted };
}

// ---------------------------------------------------------------------------
// Animation math (all pure functions of elapsed = srcT - word.start, seconds)
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Closed-form underdamped spring displacement 1 -> 0 (overshoots). */
function springScale(elapsed: number, from: number, to: number): number {
  const omega = 21;
  const zeta = 0.36;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const env = Math.exp(-zeta * omega * elapsed);
  const osc = Math.cos(wd * elapsed) + ((zeta * omega) / wd) * Math.sin(wd * elapsed);
  const displacement = env * osc; // 1 at t=0 -> decays to 0
  return to - (to - from) * displacement;
}

/**
 * Active-word bounce envelope. Returns a scale multiplier that SNAPS to a peak the
 * instant a word is spoken (elapsed = srcT - word.start, seconds) then springs back
 * to exactly 1 -- reusing the same underdamped spring as the block entrance. `pop`
 * is the CaptionStyle.activePop amount (0 = flat 1, ~0.4 = a firm bounce). The
 * spring runs from (1 + pop) down to 1, so t=0 gives the peak punch and it settles
 * to 1 with one crisp overshoot. After the short window it is pinned to 1 so a long
 * word doesn't keep breathing. Pure + loop-safe (no shadowBlur, no allocation).
 */
function activePopScale(pop: number, elapsedSec: number): number {
  if (pop <= 0 || elapsedSec < 0) return 1;
  // The bounce is a brief punctuation, not a sustained pulse: past ~0.42s the
  // spring has effectively settled, so clamp to 1 to avoid a slow residual wobble
  // on words that stay on screen a long time.
  if (elapsedSec > 0.42) return 1;
  return springScale(elapsedSec, 1 + pop, 1);
}

/** Entrance scale for a block/word given its animation + elapsed time. */
function entranceScale(
  anim: CaptionAnim,
  elapsedSec: number,
  durMs: number
): number {
  if (anim === "none" || anim === "fade" || anim === "wipe" || anim === "type") return 1;
  const p = clamp01(elapsedSec / (durMs / 1000));
  if (anim === "pop") return 0.72 + (1 - 0.72) * easings.easeOutBack(p);
  if (anim === "spring") return springScale(elapsedSec, 0.8, 1.0);
  // Solo punch: a stronger underdamped spring from small -> full so a lone word
  // SNAPS onto the frame and settles with a single crisp overshoot.
  if (anim === "punch") return springScale(elapsedSec, 0.55, 1.0);
  return 1;
}

/** Entrance opacity (fade/pop share a quick fade-in; others opaque). */
function entranceAlpha(anim: CaptionAnim, elapsedSec: number, durMs: number): number {
  if (anim === "none" || anim === "spring" || anim === "punch") return 1;
  // Typewriter reveals per-character (not by fading the block), so hold full alpha.
  if (anim === "type") return 1;
  return clamp01(elapsedSec / (durMs / 1000));
}

// ---------------------------------------------------------------------------
// Clawd mascot (for the "clawd-hop" template)
// ---------------------------------------------------------------------------
// Self-contained so this file keeps its zero-DOM / zero-asset contract and draws
// IDENTICALLY in the live preview and the WebCodecs OffscreenCanvas export. The
// grids + colors mirror lib/clawd (Claude theme ONLY -- brand mascot color).
// Cells: 0 empty, 1 body, 2 eye, 3 shadow, 4 white. Blur-free (fillRect only).

/** Official Claude mascot color -- the ONLY palette this template uses. */
const CLAWD_CLAUDE = { body: "#CD7B5A", shadow: "#CA7356", eye: "#1A1A1A" } as const;

// Expression grids (subset kept compact but varied -- happy, wink, cool, normal,
// surprised, dancing). Each is [rows][cols] with the same encoding as lib/clawd.
const CLAWD_GRIDS: number[][][] = [
  // normal
  [
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,1,1,2,1,1,2,1,1,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [1,1,1,1,1,1,1,1,1,1,1,1,1],
    [1,1,1,1,1,1,1,1,1,1,1,1,1],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,0,1,0,0,0,1,0,1,0,0],
    [0,0,1,0,1,0,0,0,1,0,1,0,0],
    [0,0,1,0,1,0,0,0,1,0,1,0,0],
  ],
  // happy (raised hands + smile)
  [
    [0,0,0,1,1,0,0,0,1,1,0,0,0],
    [0,0,0,1,1,0,0,0,1,1,0,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,1,2,1,1,1,2,1,1,0,0],
    [0,0,1,2,1,2,1,2,1,2,1,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,3,0,3,0,0,0,3,0,3,0,0],
    [0,0,1,0,1,0,0,0,1,0,1,0,0],
    [0,0,1,0,1,0,0,0,1,0,1,0,0],
  ],
  // wink
  [
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,1,2,2,1,1,2,2,1,0,0],
    [0,0,1,1,2,2,1,1,1,1,1,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [1,1,1,1,1,1,1,1,1,1,1,1,1],
    [1,1,1,1,1,1,1,1,1,1,1,1,1],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,0,1,0,0,0,1,0,1,0,0],
    [0,0,1,0,1,0,0,0,1,0,1,0,0],
    [0,0,1,0,1,0,0,0,1,0,1,0,0],
  ],
  // cool (sunglasses)
  [
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,3,3,3,3,1,3,3,3,3,0,0],
    [0,0,2,2,2,2,1,2,2,2,2,0,0],
    [0,0,2,2,2,2,1,2,2,2,2,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [1,1,1,1,1,1,1,1,1,1,1,1,1],
    [1,1,1,1,1,1,1,1,1,1,1,1,1],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,0,1,0,0,0,1,0,1,0,0],
    [0,0,1,0,1,0,0,0,1,0,1,0,0],
    [0,0,1,0,1,0,0,0,1,0,1,0,0],
  ],
  // surprised (wide white eyes)
  [
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,1,4,4,1,1,4,4,1,0,0],
    [0,0,1,1,2,4,1,1,2,4,1,0,0],
    [0,0,1,1,4,4,1,1,4,4,1,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [1,1,1,1,1,1,1,1,1,1,1,1,1],
    [1,1,1,1,1,1,1,1,1,1,1,1,1],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,0,1,0,0,0,1,0,1,0,0],
    [0,0,1,0,1,0,0,0,1,0,1,0,0],
    [0,0,1,0,1,0,0,0,1,0,1,0,0],
  ],
  // dancing (splayed legs, 2x2 eyes)
  [
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,1,2,2,1,1,2,2,1,0,0],
    [0,0,1,1,2,2,1,1,2,2,1,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [1,1,1,1,1,1,1,1,1,1,1,1,1],
    [1,1,1,1,1,1,1,1,1,1,1,1,1],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,1,0,0,1,0,0,0,1,0,0,1,0],
    [0,1,0,0,1,0,0,0,1,0,0,1,0],
    [1,0,0,0,1,0,0,0,1,0,0,0,1],
  ],
];
const CLAWD_ROWS = 11; // every grid above is 11 rows tall
const CLAWD_COLS = 13; // ...and 13 cols wide -> a fixed 13x11 sprite box

/**
 * Pick a Clawd expression for a block deterministically (stable across
 * preview/export -- NEVER Math.random). Hashes the block id so each block gets a
 * repeatable but varied face; consecutive blocks land on different grids.
 */
function clawdGridForBlock(block: CaptionBlock, index: number): number[][] {
  let h = 2166136261 >>> 0; // FNV-1a over the id
  const s = block.id || `b${index}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return CLAWD_GRIDS[(h + index) % CLAWD_GRIDS.length];
}

/**
 * Draw a Clawd grid centered at (cx, cy) fitting inside `boxW` x `boxH`.
 * Blur-free (fillRect only), loop-safe. Uses the Claude palette only.
 */
function drawClawdSprite(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  grid: number[][],
  cx: number,
  cy: number,
  boxW: number,
  boxH: number
): void {
  const px = Math.min(boxW / CLAWD_COLS, boxH / CLAWD_ROWS);
  const gw = CLAWD_COLS * px;
  const gh = CLAWD_ROWS * px;
  const ox = cx - gw / 2;
  const oy = cy - gh / 2;
  const overlap = px * 0.06; // hide sub-pixel seams under scaling
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (cell === 0) continue;
      ctx.fillStyle =
        cell === 2 ? CLAWD_CLAUDE.eye : cell === 3 ? CLAWD_CLAUDE.shadow : cell === 4 ? "#FFFFFF" : CLAWD_CLAUDE.body;
      ctx.fillRect(ox + c * px - overlap, oy + r * px - overlap, px + overlap * 2, px + overlap * 2);
    }
  }
}

/**
 * Compute where the hopping mascot sits RIGHT NOW for a laid-out line.
 * Returns the target-word center X, a hop-arc lift (0 at rest, up during a jump),
 * a squash factor for the landing, and the target word's measured width (so the
 * caller can clamp the sprite so it never overflows a tiny word like "OF").
 *
 * The mascot rests over the SPOKEN word; as narration moves to the next word it
 * arcs across the gap. Pure function of srcT + the block's word timings.
 */
function clawdHopState(
  line: LaidLine,
  block: CaptionBlock,
  srcT: number
): { centerX: number; lift: number; squash: number; wordWidth: number } | null {
  if (line.words.length === 0) return null;

  // The active word index within this line (the one being spoken). Fall back to
  // the nearest already-spoken word, else the first word.
  let activeIdx = -1;
  let lastSpoken = 0;
  for (let i = 0; i < line.words.length; i++) {
    const w = block.words[line.words[i].wordIndex];
    if (srcT >= w.start && srcT <= w.end) { activeIdx = i; break; }
    if (srcT > w.end) lastSpoken = i;
  }
  const restIdx = activeIdx >= 0 ? activeIdx : lastSpoken;

  const centerOf = (i: number) => line.words[i].x + line.words[i].width / 2;

  // Are we mid-hop between restIdx and restIdx+1? A hop plays in the GAP between
  // the current word's end and the next word's start (or the tail of the word if
  // there's no gap), so the mascot has left the old word before the new is spoken.
  const HOP_LEAD = 0.14; // seconds of arc before the next word begins
  const nextIdx = restIdx + 1;
  let centerX = centerOf(restIdx);
  let lift = 0;
  let squash = 0;
  let wordWidth = line.words[restIdx].width;

  if (nextIdx < line.words.length) {
    const nextWord = block.words[line.words[nextIdx].wordIndex];
    const hopStart = nextWord.start - HOP_LEAD;
    if (srcT >= hopStart && srcT < nextWord.start) {
      const p = clamp01((srcT - hopStart) / HOP_LEAD); // 0..1 across the arc
      const from = centerOf(restIdx);
      const to = centerOf(nextIdx);
      centerX = from + (to - from) * easings.easeInOutCubic(p);
      lift = Math.sin(Math.PI * p); // parabolic arc, peak mid-hop
      // interpolate the clamp width toward the destination so it fits on landing
      wordWidth = line.words[restIdx].width + (line.words[nextIdx].width - line.words[restIdx].width) * p;
    } else if (srcT >= nextWord.start) {
      // Already landed on the next word (covers zero-gap words).
      centerX = centerOf(nextIdx);
      wordWidth = line.words[nextIdx].width;
    }
  }

  // A brief squash right after landing on the active word (spring settle).
  if (activeIdx >= 0) {
    const w = block.words[line.words[activeIdx].wordIndex];
    const sinceLand = srcT - w.start;
    if (sinceLand >= 0 && sinceLand < 0.16) {
      squash = Math.max(0, 1 - sinceLand / 0.16);
    }
  }

  return { centerX, lift, squash, wordWidth };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export interface DrawCaptionsOptions {
  /** The global caption style (block overrides applied per block). */
  style: CaptionStyle;
  /** All caption blocks (SOURCE-time). */
  blocks: readonly CaptionBlock[];
  /** Current SOURCE time (from timelineToSourceTime(clips, playhead)); null = hold nothing. */
  srcT: number | null;
  width: number;
  height: number;
  /**
   * The split ratio (fraction of height given to the top/screen half). When a
   * style has pinToSplit=true, captions anchor to this seam so they track the
   * split handle as it's dragged. Falls back to positionYPct when absent.
   */
  splitRatio?: number;
}

/**
 * Draw the active caption block for `srcT` onto ctx, AFTER drawFrame. Pure: no
 * DOM, no store. Picks the block whose [start, end] window contains srcT (plus
 * the block's own entrance/exit padding), lays out + animates it, and draws
 * pill/stroke/fill per the resolved style. Never sets ctx.shadowBlur.
 */
export function drawCaptions(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  opts: DrawCaptionsOptions
): void {
  const { style: globalStyle, blocks, srcT, width, height, splitRatio } = opts;
  if (srcT === null || blocks.length === 0) return;

  // Find the active block. A small lead/lag window keeps a block visible through
  // its entrance/exit animation even a hair before/after its word timings.
  // Prefer a STRICT [start, end] containment match so back-to-back blocks
  // (gap <= LEAD) resolve to the one actually being spoken -- otherwise a prior
  // block's exit-lead would over-hold and eat the next block's entrance. Fall
  // back to the padded LEAD window only when NO block strictly contains srcT.
  const LEAD = 0.05;
  let active: CaptionBlock | null = null;
  for (const b of blocks) {
    if (srcT >= b.start && srcT <= b.end) {
      active = b;
      break;
    }
  }
  if (!active) {
    for (const b of blocks) {
      if (srcT >= b.start - LEAD && srcT <= b.end + LEAD) {
        active = b;
        break;
      }
    }
  }
  if (!active) return;

  const style = resolveBlockStyle(globalStyle, active);
  const nominalSizePx = style.sizePct * width;
  // Pin to the split seam when asked (and we know where it is) so captions
  // track the split handle as it's dragged; else use the absolute anchor.
  const baselineY =
    style.pinToSplit && typeof splitRatio === "number"
      ? (splitRatio + style.splitOffsetPct) * height
      : style.positionYPct * height;

  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const setFont = (px: number) => {
    ctx.font = captionFontString(style.font, style.weight, px);
  };
  setFont(nominalSizePx);
  (ctx as CanvasRenderingContext2D).lineJoin = "round";
  (ctx as CanvasRenderingContext2D).miterLimit = 2;

  // Lay out + AUTO-FIT: layoutBlock shrinks the font if the block would overflow
  // the safe zone and returns the effective size. All size-derived metrics below
  // (stroke, line height, box padding, glow, mascot) use this fitted `sizePx` so
  // everything scales together. The common case (fits) returns the nominal size
  // unchanged, so unaffected captions look exactly as before. ctx.font is left at
  // the fitted size by layoutBlock.
  const { lines, sizePx } = layoutBlock(
    ctx,
    active,
    style,
    nominalSizePx,
    width,
    baselineY,
    setFont
  );

  // Block-level entrance (Beast/Word-Pop pop the whole phrase together).
  const blockElapsed = srcT - active.start;
  const blockScale = entranceScale(style.anim, blockElapsed, style.animDurationMs);
  const blockAlpha = entranceAlpha(style.anim, blockElapsed, style.animDurationMs);
  ctx.globalAlpha = blockAlpha;

  // Scale the whole block about the baseline center for pop/spring entrances.
  if (blockScale !== 1) {
    const cx = width / 2;
    ctx.translate(cx, baselineY);
    ctx.scale(blockScale, blockScale);
    ctx.translate(-cx, -baselineY);
  }

  const strokePx = style.strokeWidthPct * sizePx;
  const lineHeight = style.lineHeightMul * sizePx;
  const padX = style.boxPadXPct * sizePx;
  const padY = style.boxPadYPct * sizePx;
  const radius = style.boxRadiusPct * lineHeight;

  const isTypewriter = style.template === "typewriter";
  const isCleanMinimal = style.template === "clean-minimal";
  // Templates whose backing box spans the WHOLE line and is drawn ONCE per line
  // (outside the per-word loop) rather than one box per word. Per-word boxes
  // overlap when padX exceeds half the inter-word gap, compounding a translucent
  // box's alpha into a dark seam between words; a single line-spanning box has no
  // seam. (Typewriter's dark terminal box + Clean Minimal's translucent plate.)
  const isLineBox = isTypewriter || isCleanMinimal;

  // --- Clawd Peek: draw the mascot BEHIND the words (before the word loop) so the
  // text overlaps its lower half -- it reads as hiding behind the caption, peeking
  // up over the spoken word and ducking as narration moves on. Slightly larger
  // than the hop mascot per the look. Blur-free grid sprite, loop-safe.
  if (style.template === "clawd-peek" && lines.length > 0) {
    const line = lines[0];
    if (line.words.length > 0) {
      // Active word (or the nearest already-spoken one) = where Clawd peeks up.
      let activeI = -1;
      let lastI = 0;
      for (let i = 0; i < line.words.length; i++) {
        const w = active.words[line.words[i].wordIndex];
        if (srcT >= w.start && srcT <= w.end) { activeI = i; break; }
        if (srcT > w.end) lastI = i;
      }
      const restI = activeI >= 0 ? activeI : lastI;
      const w = active.words[line.words[restI].wordIndex];
      // Peek 0..1: rise as the word starts, hold through it, duck as it ends.
      const RISE = 0.13;
      const up = Math.min(
        clamp01((srcT - w.start) / RISE), // rising in at the word's start
        clamp01((w.end - srcT) / RISE) // ducking out toward the word's end
      );
      const peek = activeI >= 0 ? up : 0.18; // between words: barely peeking
      const cx = line.words[restI].x + line.words[restI].width / 2;

      // Slightly larger than the hop sprite (user wants it a touch bigger).
      const capH = sizePx;
      const boxH = capH * 0.98;
      const boxW = boxH * (CLAWD_COLS / CLAWD_ROWS);
      const capTop = line.y - capH * 0.92;
      const hiddenY = capTop + boxH * 0.55; // mostly behind the caps
      const peekedY = capTop - boxH * 0.42; // popped up over the word
      const cy = hiddenY + (peekedY - hiddenY) * easings.easeOutBack(clamp01(peek));

      ctx.save();
      ctx.globalAlpha = blockAlpha;
      const grid = clawdGridForBlock(active, blocks.indexOf(active));
      drawClawdSprite(ctx, grid, cx, cy, boxW, boxH);
      ctx.restore();
    }
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    // --- line-spanning backing box (drawn once, outside the per-word loop so it
    // never re-fills per glyph and translucent alpha never compounds). ----------
    if (isLineBox && style.boxColor) {
      const bx = (width - line.width) / 2 - padX;
      const by = line.y - lineHeight * 0.8 - padY;
      const bw = line.width + padX * 2;
      const bh = lineHeight + padY * 2;
      ctx.fillStyle = style.boxColor;
      roundRectPath(ctx, bx, by, bw, bh, radius);
      ctx.fill();
    }

    for (const lw of line.words) {
      const word = active.words[lw.wordIndex];
      const isActive =
        srcT >= word.start && srcT <= word.end;
      // Typewriter: a word is fully shown once its time has passed; the ACTIVE
      // word types in char-by-char; future words are hidden entirely.
      const isFuture = isTypewriter && srcT < word.start;
      if (isFuture) continue;
      const isKeyword =
        active.keywordIndex !== undefined && active.keywordIndex === lw.wordIndex;

      // --- active-word SCALE-POP (opt-in via style.activePop) -----------------
      // The spoken word bounces about its OWN center the instant it's spoken, then
      // springs to 1. We scale here so EVERY per-word draw below (box, glow,
      // shadow, stroke, fill, wipe) transforms together -- no tearing between the
      // outline and the fill. Pure transform, blur-free, loop-safe -> preview ==
      // export. Skipped entirely (no save/restore) when off or the word is idle,
      // so untouched captions are byte-identical to before.
      const popAmt = style.activePop ?? 0;
      const wordPop = isActive ? activePopScale(popAmt, srcT - word.start) : 1;
      const popped = wordPop !== 1;
      if (popped) {
        // Glyph center: horizontal mid of the word, vertical mid of the cap band
        // (~0.36 * sizePx above the baseline reads as the optical center of caps).
        const pcx = lw.x + lw.width / 2;
        const pcy = line.y - sizePx * 0.36;
        ctx.save();
        ctx.translate(pcx, pcy);
        ctx.scale(wordPop, wordPop);
        ctx.translate(-pcx, -pcy);
      }

      // Per-template active/keyword coloring. The accent color follows the word
      // being SPOKEN RIGHT NOW (isActive), sweeping left-to-right across the line
      // as narration progresses -- for word-pop, highlight-box, karaoke, and
      // beast alike. For word-pop we additionally fall back to accenting the
      // block's keyword when NO word is currently active (e.g. a tiny gap between
      // words), so the phrase never flashes fully un-accented mid-line.
      let fill = style.fill;
      const anyActiveInBlock = active.words.some(
        (w) => srcT >= w.start && srcT <= w.end
      );
      if (style.template === "word-pop") {
        if (isActive) fill = style.activeFill;
        else if (!anyActiveInBlock && isKeyword) fill = style.activeFill;
      } else if (style.template === "two-tone-stack") {
        // Line 1 uses `fill`, line 2 uses `secondLineFill`; spoken word -> accent.
        if (li === 1 && style.secondLineFill) fill = style.secondLineFill;
        if (isActive) fill = style.activeFill;
      } else if (
        style.template === "highlight-box" ||
        style.template === "beast-bounce" ||
        style.template === "single-punch" ||
        style.template === "gradient-pop" ||
        style.template === "typewriter"
      ) {
        if (isActive) fill = style.activeFill;
      }
      // NOTE: karaoke-wipe deliberately does NOT promote the active word to
      // activeFill here. Its base draw must stay idle-fill so the clipped
      // left-to-right wipe below is what reveals activeFill -- promoting it here
      // would paint activeFill under the wipe, making the reveal invisible and
      // the word hard-snap to the accent color.

      // Gradient fill (Gradient Pop): build a vertical gradient over the glyph's
      // cap band, unless the spoken word overrode to a flat accent. A canvas
      // gradient is a valid fillStyle, so it slots straight into `fill`.
      let fillStyle: string | CanvasGradient = fill;
      if (
        style.template === "gradient-pop" &&
        style.gradientFrom &&
        style.gradientTo &&
        !isActive // spoken word flips to flat white for contrast
      ) {
        const gTop = line.y - lineHeight * 0.72;
        const gBot = line.y + lineHeight * 0.12;
        const grad = ctx.createLinearGradient(0, gTop, 0, gBot);
        grad.addColorStop(0, style.gradientFrom);
        grad.addColorStop(1, style.gradientTo);
        fillStyle = grad;
      }

      // --- per-word active pill (Highlight Box only) -------------------------
      // Only Highlight Box draws a box PER WORD (a pill around the spoken word).
      // Line-spanning boxes (Typewriter, Clean Minimal) are drawn once per line
      // above -- drawing them per word here would overlap and, for a translucent
      // plate, compound alpha into a dark seam between words.
      const wantBox =
        style.boxColor &&
        style.template === "highlight-box" &&
        isActive; // pill only around the active word
      if (wantBox) {
        const bx = lw.x - padX;
        const by = line.y - lineHeight * 0.8 - padY;
        const bw = lw.width + padX * 2;
        const bh = lineHeight + padY * 2;
        ctx.fillStyle = style.boxColor;
        roundRectPath(ctx, bx, by, bw, bh, radius);
        ctx.fill();
      }

      const emoji = isEmoji(lw.text);

      // --- glow halo (loop-safe, blur-free) ----------------------------------
      // A soft bloom faked with a few concentric translucent strokes of growing
      // width. No ctx.shadowBlur (banned in loops). Only the SPOKEN word glows,
      // so the accent tracks narration. Drawn first so the glyph sits on top.
      // (Used by Solo's coral bloom.)
      if (style.glowColor && isActive && !emoji) {
        ctx.strokeStyle = style.glowColor;
        (ctx as CanvasRenderingContext2D).lineJoin = "round";
        // Widest & faintest ring first, tightening inward -> a graduated bloom.
        const rings: Array<[number, number]> = [
          [0.42, 0.22],
          [0.3, 0.4],
          [0.18, 0.7],
        ];
        for (const [wMul, aMul] of rings) {
          ctx.save();
          ctx.globalAlpha = blockAlpha * aMul;
          ctx.lineWidth = sizePx * wMul;
          strokeSpacedText(ctx, lw.text, lw.x, line.y, style.letterSpacingPct * sizePx);
          ctx.restore();
        }
      }

      // --- hard offset drop shadow (blur-free, loop-safe) --------------------
      if (style.shadowColor && !emoji) {
        ctx.fillStyle = style.shadowColor;
        drawSpacedText(ctx, lw.text, lw.x + sizePx * 0.03, line.y + sizePx * 0.04, style.letterSpacingPct * sizePx);
      }

      // --- stroke then fill (outline sits behind the glyph) ------------------
      if (style.strokeColor && strokePx > 0 && !emoji) {
        ctx.strokeStyle = style.strokeColor;
        ctx.lineWidth = strokePx * 2; // canvas strokes centered; 2x -> full outside width
        strokeSpacedText(ctx, lw.text, lw.x, line.y, style.letterSpacingPct * sizePx);
      }

      // --- typewriter: reveal the ACTIVE word char-by-char + blinking caret --
      if (isTypewriter && isActive && !emoji) {
        const spacingPx = style.letterSpacingPct * sizePx;
        const chars = [...lw.text];
        const dur = Math.max(1e-3, word.end - word.start);
        const revealed = Math.min(
          chars.length,
          Math.floor(chars.length * clamp01((srcT - word.start) / dur) + 1e-6)
        );
        ctx.fillStyle = fill;
        let cx = lw.x;
        for (let ci = 0; ci < revealed; ci++) {
          ctx.fillText(chars[ci], cx, line.y);
          cx += ctx.measureText(chars[ci]).width + spacingPx;
        }
        // Blinking caret at the reveal frontier (half-period = animDurationMs).
        const blink = Math.floor(blockElapsed / (style.animDurationMs / 1000)) % 2 === 0;
        if (blink) {
          ctx.fillStyle = style.activeFill;
          ctx.fillText("|", cx + spacingPx * 0.4, line.y);
        }
      } else {
        ctx.fillStyle = fillStyle;
        drawSpacedText(ctx, lw.text, lw.x, line.y, style.letterSpacingPct * sizePx);
      }

      // --- karaoke wipe: reveal the active word's activeFill left-to-right ---
      if (style.template === "karaoke-wipe" && isActive && !emoji) {
        const wp = clamp01((srcT - word.start) / Math.max(1e-3, word.end - word.start));
        ctx.save();
        ctx.beginPath();
        ctx.rect(lw.x, line.y - lineHeight, lw.width * wp, lineHeight * 2);
        ctx.clip();
        ctx.fillStyle = style.activeFill;
        drawSpacedText(ctx, lw.text, lw.x, line.y, style.letterSpacingPct * sizePx);
        ctx.restore();
      }

      // Close the active-word pop transform opened above (if any).
      if (popped) ctx.restore();
    }
  }

  // --- Clawd Hop: ONE pixel mascot per block, hopping word -> word ------------
  // Drawn AFTER the words (so it perches on top) and OUTSIDE the block-entrance
  // scale (its own hop is the motion). One mascot for the whole line; a
  // deterministic per-block expression keeps consecutive lines unique.
  if (style.template === "clawd-hop" && lines.length > 0) {
    const line = lines[0];
    const hop = clawdHopState(line, active, srcT);
    if (hop) {
      // FIXED size tied to the (fitted) text height -- NOT the word width. The
      // mascot must read the SAME over a 2-letter word ("OF") as over a long one;
      // shrinking it to hug tiny words looked wrong. It still hops to each word's
      // center, it just keeps a consistent, comfortable size. Sprite is 13x11, so
      // at ~0.82 cap height it's a touch over 1 cap-height wide -- natural above
      // any word, and it never approaches the screen edge (the words themselves
      // are already safe-zone-fitted, and the mascot is far narrower than a line).
      const capH = sizePx; // fitted cap height
      const boxH = capH * 0.82;
      const boxW = boxH * (CLAWD_COLS / CLAWD_ROWS);

      // Sit just above the caps, lifting on the hop arc. Cap top ~= baseline - capH.
      const capTop = line.y - capH * 0.92;
      const restGap = capH * 0.14; // small breathing room above the text
      const hopHeight = capH * 0.55; // how high the arc peaks
      const cx = hop.centerX;
      const cy = capTop - restGap - boxH / 2 - hop.lift * hopHeight;

      ctx.save();
      ctx.globalAlpha = blockAlpha;
      if (hop.squash > 0) {
        // Land squash: widen + flatten briefly about the sprite's base.
        const sx = 1 + 0.16 * hop.squash;
        const sy = 1 - 0.16 * hop.squash;
        const baseY = cy + boxH / 2;
        ctx.translate(cx, baseY);
        ctx.scale(sx, sy);
        ctx.translate(-cx, -baseY);
      }
      const grid = clawdGridForBlock(active, blocks.indexOf(active));
      drawClawdSprite(ctx, grid, cx, cy, boxW, boxH);
      ctx.restore();
    }
  }

  // --- Underline Hold: steady dim rail + ONE bright segment gliding to the word -
  // Tuned for fast speech: the underline NEVER redraws per word (that strobes).
  // A dim rail sits under the whole phrase; a bright segment eases word->word via
  // the same read-head math as the Clawd hop. Text stays fully stable; only the
  // bright segment moves. Blur-free (plain strokes), loop-safe.
  if (style.template === "underline-hold" && lines.length > 0 && style.underlineColor) {
    const line = lines[0];
    const hop = clawdHopState(line, active, srcT); // reuse: centerX + wordWidth ease word->word
    if (hop && line.words.length > 0) {
      const uy = line.y + sizePx * 0.16; // just under the baseline
      const railW = sizePx * 0.09;
      const segW = sizePx * 0.13;
      const first = line.words[0];
      const last = line.words[line.words.length - 1];
      const railL = first.x;
      const railR = last.x + last.width;

      ctx.save();
      ctx.lineCap = "round";
      // steady dim rail spanning the whole phrase (drawn once, never per-word)
      if (style.underlineRailColor) {
        ctx.strokeStyle = style.underlineRailColor;
        ctx.lineWidth = railW;
        ctx.beginPath();
        ctx.moveTo(railL, uy);
        ctx.lineTo(railR, uy);
        ctx.stroke();
      }
      // bright segment gliding under the active word (eased position + width)
      const segL = hop.centerX - hop.wordWidth / 2;
      const segR = hop.centerX + hop.wordWidth / 2;
      ctx.strokeStyle = style.underlineColor;
      ctx.lineWidth = segW;
      ctx.beginPath();
      ctx.moveTo(Math.max(railL, segL), uy);
      ctx.lineTo(Math.min(railR, segR), uy);
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Text-drawing primitives (letter-spacing aware)
// ---------------------------------------------------------------------------

/** Draw `text` with per-glyph letter spacing (canvas has no native tracking). */
function drawSpacedText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number
): void {
  if (spacing === 0) {
    ctx.fillText(text, x, y);
    return;
  }
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
}

function strokeSpacedText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number
): void {
  if (spacing === 0) {
    ctx.strokeText(text, x, y);
    return;
  }
  let cx = x;
  for (const ch of text) {
    ctx.strokeText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
}

/** Build a rounded-rect path (Chrome has ctx.roundRect; fall back if absent). */
function roundRectPath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (typeof (ctx as CanvasRenderingContext2D).roundRect === "function") {
    (ctx as CanvasRenderingContext2D).roundRect(x, y, w, h, rr);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
