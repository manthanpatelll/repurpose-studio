// ===========================================================================
// Repurpose Studio hub -- EmptyState
// ===========================================================================
// Shown when no projects exist yet. A coral FilmSlate badge, a line of copy,
// and a big "New Project" CTA that mints a provisional project in the editor.
// ===========================================================================

import { FilmSlate, Plus } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

export function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="grid place-items-center rounded-3xl border border-border bg-card py-28">
      <div className="text-center">
        <div className="mx-auto mb-6 grid size-16 place-items-center rounded-2xl border border-primary/30 bg-primary/10 text-primary">
          <FilmSlate size={30} weight="fill" />
        </div>
        <h3 className="text-2xl font-black tracking-tight text-foreground">
          No projects yet
        </h3>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          Start a project, drop in your raw footage + transcript, and Repurpose
          Studio cuts it into a vertical Reel.
        </p>
        <Button size="lg" onClick={onNew} className="mt-6 gap-2">
          <Plus size={18} weight="bold" />
          New Project
        </Button>
      </div>
    </div>
  );
}
