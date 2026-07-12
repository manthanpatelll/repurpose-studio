// ===========================================================================
// Repurpose Studio hub -- display formatters
// ===========================================================================
// Small, pure string helpers shared across the hub cards/rows. No React here,
// so they stay trivially testable and reusable from any component.
// ===========================================================================

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * "M:SS" duration -- mirrors the editor's own formatDuration exactly so a
 * project reads the same length on the hub card and inside the editor.
 */
export function formatDuration(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * The project's absolute CREATED date, always shown as a short "7 Jul 26"
 * (day + short month + 2-digit year) -- matches the URL slug's date and never
 * degrades to a relative "N ago" string, so the Created column always reads a
 * real date. Guards a bad/empty ISO string by returning "".
 */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const yy = (d.getFullYear() % 100).toString().padStart(2, "0");
  return `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} ${yy}`;
}
