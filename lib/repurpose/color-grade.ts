// ===========================================================================
// REPURPOSE STUDIO -- color-grade presets
// ===========================================================================
// Descript-style "Color adjustments" preset rail: a small registry of subtle,
// premium LUT-like grades expressed as CSS `filter` lists. Each grade's
// `filter` string is fed straight to `ctx.filter` in the compositor
// (lib/repurpose/compositor.ts) before the region's `drawImage`, so the SAME
// grade renders in the live PreviewCanvas and the MP4 export -- what you see
// is what you get.
//
// DESIGN CONSTRAINTS (these run on a REAL face cam, not a test pattern):
//   - Skin tones must stay natural. NEVER hue-rotate beyond ~10deg.
//   - Grades are subtle nudges, not Instagram-neon looks. `pop`/`vivid` push
//     contrast + saturation, not hue.
//   - `filter: ""` means "draw untouched" -- the first entry (id "none") is
//     always the do-nothing baseline the store defaults to.
//
// The `filter` grammar is the standard CSS/Canvas filter functions
// (brightness/contrast/saturate/sepia/hue-rotate/grayscale). ctx.filter with
// this grammar is supported on both CanvasRenderingContext2D and
// OffscreenCanvasRenderingContext2D in Chrome, which is the only target here
// (local Chrome-only project).
// ===========================================================================

/** One color-grade preset. `filter` is a CSS filter list ("" = untouched). */
export interface ColorGrade {
  /** Stable id persisted in the store (screenGrade / faceGrade). */
  id: string;
  /** Human label for the preset-rail tile. */
  label: string;
  /** CSS filter list applied via ctx.filter before drawImage. "" = no-op. */
  filter: string;
}

/**
 * The preset rail, in display order. First entry MUST be `none` (the empty,
 * do-nothing baseline the store defaults both tracks to).
 */
export const COLOR_GRADES: ColorGrade[] = [
  // Untouched baseline -- draw the region exactly as decoded.
  { id: "none", label: "None", filter: "" },
  // Gentle normalize: a touch of contrast + saturation so flat footage reads clean.
  { id: "neutral", label: "Neutral", filter: "contrast(1.05) saturate(1.05)" },
  // Golden hour warmth: lift brightness, a whisper of sepia, richer color -- no hue shift.
  { id: "warm", label: "Warm", filter: "brightness(1.04) sepia(0.12) saturate(1.14)" },
  // Cool daylight: a small blue-leaning hue nudge + modest saturation, skin stays safe.
  { id: "cool", label: "Cool", filter: "hue-rotate(8deg) saturate(1.08) brightness(1.01)" },
  // Punchy: stronger contrast + saturation for a crisp, vibrant grade.
  { id: "pop", label: "Pop", filter: "contrast(1.15) saturate(1.35)" },
  // Cinematic: lifted blacks (contrast <1), muted color, faint sepia, slight lift.
  { id: "film", label: "Film", filter: "contrast(0.96) saturate(0.9) sepia(0.06) brightness(1.03)" },
  // Bold: pushes further than Pop on contrast + saturation, still short of neon.
  { id: "vivid", label: "Vivid", filter: "contrast(1.22) saturate(1.5)" },
  // Monochrome: full grayscale with a contrast bump so it doesn't read muddy.
  { id: "bw", label: "B&W", filter: "grayscale(1) contrast(1.1)" },
  // Moody: darker, desaturated, higher contrast for a dramatic low-key look.
  { id: "moody", label: "Moody", filter: "brightness(0.92) saturate(0.8) contrast(1.18)" },
];

/** Fast id -> filter lookup, built once from the registry. */
const GRADE_BY_ID: ReadonlyMap<string, ColorGrade> = new Map(
  COLOR_GRADES.map((g) => [g.id, g])
);

/**
 * Resolve a grade id to its CSS filter string. Unknown ids and the "none"
 * baseline both resolve to "" (untouched), so callers can pass a possibly-stale
 * store value straight through without guarding it.
 */
export function gradeFilter(id: string): string {
  return GRADE_BY_ID.get(id)?.filter ?? "";
}
