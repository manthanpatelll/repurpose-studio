// ===========================================================================
// REPURPOSE STUDIO -- project naming + dated-slug helpers
// ===========================================================================
// Shared by the persistence hook (which derives a project's name from its
// transcript and mints its dated-slug id on auto-create) and any other code that
// needs the same title/slug logic. Pure functions, no React / store / DOM, so
// they're trivially reusable and testable.
//
// The NAME derives from the transcript (deriveShortTitle). The URL id is that
// title slugified + the CREATION DATE (datedSlug), e.g.
// "claude-routines-automation-13-jul-26" -- the date makes the id
// collision-proof across days, and the persistence layer appends -2/-3 for a
// same-day same-name collision.
// ===========================================================================

import type { Word } from "@/lib/repurpose/types";

// Filler / function words that carry no topical signal. Kept lean but covers the
// words that dominate spoken-English frequency counts.
export const NAME_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "so", "as", "of", "to", "in", "on",
  "at", "by", "for", "with", "from", "into", "onto", "up", "out", "off", "over",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did",
  "have", "has", "had", "will", "would", "can", "could", "should", "shall",
  "may", "might", "must", "this", "that", "these", "those", "it", "its", "i",
  "you", "your", "youre", "we", "our", "us", "they", "them", "their", "he",
  "she", "his", "her", "me", "my", "mine", "myself", "just", "like", "really",
  "very", "get", "got", "getting", "go", "going", "gonna", "wanna", "want",
  "here", "there", "where", "when", "what", "which", "who", "whom", "how",
  "why", "not", "no", "yes", "yeah", "okay", "ok", "some", "any", "all", "one",
  "two", "then", "than", "also", "too", "now", "well", "kind", "sort", "thing",
  "things", "stuff", "basically", "actually", "literally", "gonna", "lot",
  "much", "more", "most", "about", "because", "cause", "them", "im", "dont",
  "doesnt", "cant", "lets", "let", "make", "makes", "made", "use", "using",
  "used", "way", "ways", "does", "example",
]);

/**
 * Build a title from the loaded transcript words. Returns null when there aren't
 * enough content words yet (before any transcript is loaded), so the caller can
 * defer creating the project until a real title emerges.
 */
export function deriveShortTitle(words: readonly Word[]): string | null {
  if (words.length === 0) return null;

  // Weight the FRONT of the transcript higher -- the opening ~40 words usually
  // state the topic ("Claude just dropped routines..."), so a word there beats
  // one buried deep in an aside.
  const counts = new Map<string, { score: number; display: string }>();
  const frontier = Math.min(words.length, 120);
  for (let i = 0; i < frontier; i++) {
    const raw = words[i].text;
    const norm = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (norm.length < 3 || NAME_STOPWORDS.has(norm)) continue;
    const weight = 1 + (frontier - i) / frontier; // 2x at the very start -> 1x at word 120
    const prev = counts.get(norm);
    if (prev) prev.score += weight;
    // Keep a clean display form (strip surrounding punctuation, keep casing of the
    // raw token so proper nouns like "Claude"/"Zapier" render right).
    else counts.set(norm, { score: weight, display: raw.replace(/[^A-Za-z0-9]/g, "") });
  }

  if (counts.size === 0) return null;

  const top = [...counts.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((c) => titleCaseWord(c.display));

  const title = top.join(" ").trim();
  return title.length > 0 ? title : null;
}

export function titleCaseWord(w: string): string {
  if (w.length === 0) return w;
  // Preserve an already-capitalized proper noun / acronym (Claude, API, n8n);
  // otherwise Title-Case a lowercased content word.
  if (/[A-Z]/.test(w)) return w;
  return w[0].toUpperCase() + w.slice(1);
}

/** Slugify a label into a safe, lowercase-hyphenated stem (matches the id regex). */
export function slugifyName(label: string): string {
  return label
    .toLowerCase()
    .replace(/·/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

// Short month names for the dated slug -- lowercase so they slot straight into the
// kebab id (e.g. "13-jul-26").
const SHORT_MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

/**
 * Build the project's dated-slug id from a name + a real Date:
 *   `<slugified-name>-<day>-<shortmonth>-<yy>`  e.g. "claude-routines-automation-13-jul-26".
 * Numeric day (no leading zero, matching the "13th july" -> "13" ask), lowercase
 * short month, 2-digit year (26/27/28). The date suffix makes the id unique across
 * days; same-day same-name collisions are resolved with a -2/-3 suffix by the disk
 * store's uniqueId(). Falls back to "untitled" when the name slugs to nothing.
 */
export function datedSlug(name: string, date: Date): string {
  const base = slugifyName(name) || "untitled";
  const day = date.getDate(); // 1..31, no leading zero
  const month = SHORT_MONTHS[date.getMonth()];
  const yy = String(date.getFullYear()).slice(2); // "2026" -> "26"
  return `${base}-${day}-${month}-${yy}`;
}
