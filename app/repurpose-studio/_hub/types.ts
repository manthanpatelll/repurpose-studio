// ===========================================================================
// Repurpose Studio hub -- shared project meta type
// ===========================================================================
// Matches the /api/repurpose/projects data contract (newest-first list) that
// the persistence layer serves. The editor owns the full project; the hub only
// ever needs this lightweight meta row.
// ===========================================================================

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  durationSec: number;
}
