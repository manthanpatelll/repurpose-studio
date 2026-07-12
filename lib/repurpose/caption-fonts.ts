// ===========================================================================
// REPURPOSE STUDIO -- caption font registry + canvas loader
// ===========================================================================
// Captions are drawn on a Canvas 2D context (ctx.fillText), NOT the DOM, so a
// `next/font` import is not enough: the canvas font engine can only use a face
// once the browser has actually loaded it AND it is registered under a family
// name we then pass to `ctx.font`. This module owns both halves:
//
//   1. FONT_FAMILIES -- the picker registry. Each entry maps a stable id (stored
//      in CaptionStyle.font) to the CSS family name used in `ctx.font` and the
//      weights we ship. `cssFamily` is what actually goes into the font string.
//   2. loadCaptionFonts() -- registers every self-hosted @font-face via the CSS
//      Font Loading API (new FontFace(...).load()) and adds it to
//      document.fonts, then resolves once all faces are ready. Canvas text drawn
//      before this resolves silently falls back to a system font, so the preview
//      calls it once on mount and the export awaits it before the frame walk.
//
// The TikTok faces are self-hosted from /public/fonts/tiktok (Manthan's own
// files). Anton is pulled the same way if present; DM Sans / Fraunces are the
// app's existing families and assumed already loadable, but we still register
// document.fonts.load() calls for them so a caption draw never races their load.
// ===========================================================================

/** Stable id persisted in CaptionStyle.font. */
export type CaptionFontId =
  | "tiktokDisplay"
  | "tiktokSans"
  | "tiktokText"
  | "anton"
  | "dmSans"
  | "fraunces";

/** One selectable caption font. */
export interface CaptionFont {
  id: CaptionFontId;
  /** Human label for the picker. */
  label: string;
  /** The family name to put in `ctx.font` (must match the @font-face family). */
  cssFamily: string;
  /** Weights available; the picker offers these, the draw path clamps to nearest. */
  weights: number[];
  /** A generic fallback appended after cssFamily so text always renders. */
  fallback: string;
}

/** Self-hosted @font-face descriptors we register at runtime for canvas use. */
interface FaceSpec {
  family: string;
  weight: number;
  /** Path under /public. */
  url: string;
  /** Font format hint for the loader. */
  style?: "normal" | "italic";
}

// ---------------------------------------------------------------------------
// Registry -- what the caption panel offers.
// ---------------------------------------------------------------------------
export const CAPTION_FONTS: CaptionFont[] = [
  {
    id: "tiktokDisplay",
    label: "TikTok Display",
    cssFamily: "TikTok Display",
    weights: [400, 500, 700],
    fallback: "system-ui, sans-serif",
  },
  {
    id: "tiktokSans",
    label: "TikTok Sans",
    cssFamily: "TikTok Sans",
    weights: [400],
    fallback: "system-ui, sans-serif",
  },
  {
    id: "tiktokText",
    label: "TikTok Text",
    cssFamily: "TikTok Text",
    weights: [400, 500, 700],
    fallback: "system-ui, sans-serif",
  },
  {
    id: "anton",
    label: "Anton",
    cssFamily: "Anton",
    weights: [400],
    fallback: "Impact, system-ui, sans-serif",
  },
  {
    id: "dmSans",
    label: "DM Sans",
    cssFamily: "DM Sans",
    weights: [400, 500, 700, 800],
    fallback: "system-ui, sans-serif",
  },
  {
    id: "fraunces",
    label: "Fraunces",
    cssFamily: "Fraunces",
    weights: [400, 500, 700],
    fallback: "Georgia, serif",
  },
];

const FONT_BY_ID = new Map(CAPTION_FONTS.map((f) => [f.id, f]));

/** Resolve a possibly-stale font id to its registry entry (defaults to TikTok Display). */
export function captionFont(id: CaptionFontId | string): CaptionFont {
  return FONT_BY_ID.get(id as CaptionFontId) ?? CAPTION_FONTS[0];
}

/** Clamp a requested weight to the nearest weight the font actually ships. */
export function nearestWeight(font: CaptionFont, weight: number): number {
  let best = font.weights[0];
  let bestDelta = Math.abs(best - weight);
  for (const w of font.weights) {
    const d = Math.abs(w - weight);
    if (d < bestDelta) {
      best = w;
      bestDelta = d;
    }
  }
  return best;
}

/**
 * Build the `ctx.font` string for a font id + weight + pixel size. Weight is
 * clamped to a shipped weight, family is quoted, and the generic fallback is
 * appended so an un-loaded face still renders (as a fallback) rather than
 * throwing off measureText.
 */
export function captionFontString(
  id: CaptionFontId | string,
  weight: number,
  sizePx: number
): string {
  const font = captionFont(id);
  const w = nearestWeight(font, weight);
  return `${w} ${Math.round(sizePx)}px "${font.cssFamily}", ${font.fallback}`;
}

// ---------------------------------------------------------------------------
// Self-hosted faces -- registered into document.fonts at runtime.
// ---------------------------------------------------------------------------
const SELF_HOSTED_FACES: FaceSpec[] = [
  { family: "TikTok Display", weight: 400, url: "/fonts/tiktok/TikTokDisplayRegular.otf" },
  { family: "TikTok Display", weight: 500, url: "/fonts/tiktok/TikTokDisplayMedium.otf" },
  { family: "TikTok Display", weight: 700, url: "/fonts/tiktok/TikTokDisplayBold.otf" },
  { family: "TikTok Text", weight: 400, url: "/fonts/tiktok/TikTokTextRegular.otf" },
  { family: "TikTok Text", weight: 500, url: "/fonts/tiktok/TikTokTextMedium.otf" },
  { family: "TikTok Text", weight: 700, url: "/fonts/tiktok/TikTokTextBold.otf" },
  { family: "TikTok Sans", weight: 400, url: "/fonts/tiktok/TikTokSansClassic.ttf" },
  { family: "Anton", weight: 400, url: "/fonts/tiktok/Anton.ttf" },
  // DM Sans is a variable font (one file, weight range 100-1000). Register it
  // once at the weights the captions offer; the browser interpolates each.
  { family: "DM Sans", weight: 400, url: "/fonts/dmsans-variable.ttf" },
  { family: "DM Sans", weight: 500, url: "/fonts/dmsans-variable.ttf" },
  { family: "DM Sans", weight: 700, url: "/fonts/dmsans-variable.ttf" },
  { family: "DM Sans", weight: 800, url: "/fonts/dmsans-variable.ttf" },
  { family: "Fraunces", weight: 400, url: "/fonts/fraunces-regular.ttf" },
  { family: "Fraunces", weight: 700, url: "/fonts/fraunces-bold.ttf" },
];

let loadPromise: Promise<void> | null = null;

/**
 * Register + load every self-hosted caption face into document.fonts, and warm
 * the app fonts (DM Sans / Fraunces / Anton) that may be provided via next/font
 * or Google. Idempotent: repeated calls share one promise. Resolves when all
 * faces that CAN load have loaded; individual failures are swallowed so a
 * missing file never blocks the whole caption system (that font just falls back).
 *
 * Safe to call in the browser only (guards on document/FontFace).
 */
export function loadCaptionFonts(): Promise<void> {
  if (loadPromise) return loadPromise;
  if (typeof document === "undefined" || typeof FontFace === "undefined") {
    return Promise.resolve();
  }

  loadPromise = (async () => {
    const jobs: Promise<unknown>[] = [];

    // 1. Self-hosted faces: construct, load, and add to the document registry.
    for (const face of SELF_HOSTED_FACES) {
      const job = (async () => {
        try {
          const ff = new FontFace(face.family, `url(${face.url})`, {
            weight: String(face.weight),
            style: face.style ?? "normal",
            display: "swap",
          });
          const loaded = await ff.load();
          document.fonts.add(loaded);
        } catch {
          // Missing/failed face -> the caption falls back to a system font.
        }
      })();
      jobs.push(job);
    }

    // 2. Warm app-provided families so a caption draw never races their load.
    //    These may come from next/font or Google Fonts; document.fonts.load
    //    resolves immediately if they're already available, or once they arrive.
    const warm = ['700 48px "DM Sans"', '700 48px "Fraunces"', '400 48px "Anton"'];
    for (const spec of warm) {
      jobs.push(document.fonts.load(spec).catch(() => {}));
    }

    await Promise.all(jobs);
    // A final readiness gate so measureText is accurate for everything above.
    try {
      await document.fonts.ready;
    } catch {
      /* ignore */
    }
  })();

  return loadPromise;
}
