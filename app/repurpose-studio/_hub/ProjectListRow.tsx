// ===========================================================================
// Repurpose Studio hub -- ProjectListRow (list item)
// ===========================================================================
// A compact thumb + columns: Name (flex-1) / Duration / Created. Duration and
// Created hide on smaller widths. Delete button follows the same outside-the-
// Link pattern as the card so it never triggers navigation.
// ===========================================================================

import Link from "next/link";
import { Trash, Clock, Calendar } from "@phosphor-icons/react";
import { GradientTile } from "./GradientTile";
import { formatDuration, formatDate } from "./formatters";
import type { ProjectMeta } from "./types";

export function ProjectListRow({
  project: p,
  onDelete,
}: {
  project: ProjectMeta;
  onDelete: (p: ProjectMeta) => void;
}) {
  return (
    <div className="group relative">
      <Link
        href={`/repurpose-studio/${p.id}`}
        className="flex items-center gap-4 rounded-xl border border-border bg-card p-3 pr-14 transition-all duration-200 hover:-translate-y-px hover:border-primary/50 hover:shadow-xl hover:shadow-primary/10"
      >
        <GradientTile
          id={p.id}
          compact
          thumbSrc={`/api/repurpose/thumb?id=${encodeURIComponent(p.id)}&v=${encodeURIComponent(p.updatedAt)}`}
        />

        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-bold text-foreground transition-colors group-hover:text-primary">
            {p.name}
          </h3>
          <p className="text-[11px] tabular-nums text-muted-foreground sm:hidden">
            {formatDuration(p.durationSec)} · {formatDate(p.createdAt)}
          </p>
        </div>

        <div className="hidden w-24 shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground sm:flex">
          <Clock size={13} weight="bold" />
          {formatDuration(p.durationSec)}
        </div>

        <div className="hidden w-28 shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground md:flex">
          <Calendar size={13} weight="bold" />
          {formatDate(p.createdAt)}
        </div>
      </Link>

      {/* Delete -- outside the Link. */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDelete(p);
        }}
        aria-label={`Delete ${p.name}`}
        className="absolute right-3 top-1/2 z-10 grid size-8 -translate-y-1/2 place-items-center rounded-lg border border-border bg-secondary text-muted-foreground opacity-0 transition-all hover:border-destructive/60 hover:bg-destructive/20 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash size={15} weight="bold" />
      </button>
    </div>
  );
}
