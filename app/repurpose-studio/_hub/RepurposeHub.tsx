"use client";

// ===========================================================================
// Repurpose Studio -- PROJECTS HUB  (/repurpose-studio)
// ===========================================================================
// The Descript-style project list that fronts the studio. Lists every project
// as rows (Name | Duration | Created date), newest/oldest sortable, with a
// prominent "New Project" CTA. Clicking a project opens the editor at
// /repurpose-studio/<id>.
//
// Data comes from GET /api/repurpose/projects (newest-first). Delete hits
// DELETE /api/repurpose/projects/<id> and optimistically drops the row, rolling
// back on failure. Tokenized to the studio's dark coral theme (bg-background /
// bg-card / text-foreground / bg-primary), wrapped in `.dark` so those resolve.
// ===========================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, FilmSlate, ArrowsDownUp, Warning } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProjectListRow } from "./ProjectListRow";
import { EmptyState } from "./EmptyState";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import type { ProjectMeta } from "./types";

type SortMode = "newest" | "oldest";

export function RepurposeHub() {
  const router = useRouter();

  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>("newest");
  const [pendingDelete, setPendingDelete] = useState<ProjectMeta | null>(null);

  // ------- fetch on mount (and on Retry) --------------------------------
  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/repurpose/projects");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data: { projects?: ProjectMeta[] } = await res.json();
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load projects."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // ------- New Project -------------------------------------------------
  // Mint a provisional client id and jump straight into the editor. We do NOT
  // POST here -- the editor creates the real dated-slug project the moment a
  // name derives from the loaded transcript. This keeps the empty-editor state
  // from writing junk rows for projects the user abandons.
  const handleNewProject = useCallback(() => {
    const tempId = `new-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    router.push(`/repurpose-studio/${tempId}`);
  }, [router]);

  // ------- sort (client-side, by createdAt) ----------------------------
  const sorted = useMemo(() => {
    const list = [...projects];
    list.sort((a, b) =>
      sort === "newest"
        ? b.createdAt.localeCompare(a.createdAt)
        : a.createdAt.localeCompare(b.createdAt)
    );
    return list;
  }, [projects, sort]);

  // ------- delete flow -------------------------------------------------
  const confirmDelete = useCallback(async () => {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);

    // Optimistic remove; snapshot for rollback.
    const prev = projects;
    setProjects((list) => list.filter((p) => p.id !== target.id));

    try {
      const res = await fetch(`/api/repurpose/projects/${target.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
    } catch (err) {
      // Roll back and surface the failure.
      setProjects(prev);
      setError(
        err instanceof Error
          ? `Could not delete "${target.name}": ${err.message}`
          : `Could not delete "${target.name}".`
      );
    }
  }, [pendingDelete, projects]);

  return (
    <div className="dark min-h-dvh bg-background text-foreground">
      {/* ================= HEADER ================= */}
      <header className="relative overflow-hidden border-b border-border">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(70% 120% at 15% 0%, rgba(255,107,53,0.28) 0%, rgba(255,107,53,0.06) 35%, transparent 70%)",
          }}
        />
        <div className="relative mx-auto flex max-w-[1600px] flex-wrap items-end justify-between gap-6 px-8 pb-8 pt-12">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              <FilmSlate size={13} weight="fill" className="text-primary" />
              Repurpose Studio
            </div>
            <h1 className="text-[clamp(40px,6vw,68px)] font-black leading-[0.95] tracking-[-0.03em] text-foreground">
              Your Projects
            </h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">
              Every reel project you&apos;ve started. Open one to keep editing,
              or spin up a new cut.
            </p>
          </div>

          <Button size="lg" onClick={handleNewProject} className="gap-2">
            <Plus size={18} weight="bold" />
            New Project
          </Button>
        </div>
      </header>

      {/* ================= TOOLBAR ================= */}
      {!loading && !error && projects.length > 0 && (
        <div className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur-xl">
          <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3 px-8 py-3">
            <div className="text-xs font-medium tabular-nums text-muted-foreground">
              <span className="font-bold text-foreground">
                {projects.length}
              </span>{" "}
              {projects.length === 1 ? "project" : "projects"}
            </div>
            <div className="flex items-center gap-3">
              <Select
                value={sort}
                onValueChange={(v) => setSort(v as SortMode)}
              >
                <SelectTrigger size="sm" className="w-[150px]" aria-label="Sort">
                  <ArrowsDownUp size={14} weight="bold" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest first</SelectItem>
                  <SelectItem value="oldest">Oldest first</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      )}

      {/* ================= BODY ================= */}
      <main className="mx-auto max-w-[1600px]">
        {loading ? (
          <LoadingState />
        ) : error ? (
          <div className="grid place-items-center px-8 py-28">
            <div className="max-w-sm rounded-3xl border border-destructive/40 bg-destructive/10 p-8 text-center">
              <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-destructive/20 text-destructive">
                <Warning size={22} weight="fill" />
              </div>
              <h3 className="text-lg font-bold text-foreground">
                Couldn&apos;t load projects
              </h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{error}</p>
              <Button
                variant="outline"
                onClick={() => void loadProjects()}
                className="mt-5"
              >
                Retry
              </Button>
            </div>
          </div>
        ) : projects.length === 0 ? (
          <div className="px-8 py-12">
            <EmptyState onNew={handleNewProject} />
          </div>
        ) : (
          <div className="space-y-2.5 px-8 pb-16 pt-4">
            {/* Column header -- Name | Duration | Created, aligned to the rows. */}
            <div className="flex items-center gap-4 px-4 pb-1 pl-[4.75rem] text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              <span className="min-w-0 flex-1">Name</span>
              <span className="hidden w-24 sm:block">Duration</span>
              <span className="hidden w-28 md:block">Created</span>
              <span className="w-8" aria-hidden />
            </div>
            {sorted.map((p) => (
              <ProjectListRow
                key={p.id}
                project={p}
                onDelete={setPendingDelete}
              />
            ))}
          </div>
        )}
      </main>

      <DeleteConfirmDialog
        project={pendingDelete}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton row list while projects load. Matches the real rows so there's no
// layout shift when they arrive.
// ---------------------------------------------------------------------------
function LoadingState() {
  return (
    <div className="space-y-2.5 px-8 pb-16 pt-8" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 rounded-2xl border border-border bg-card p-3"
        >
          <div className="size-11 shrink-0 animate-pulse rounded-xl bg-secondary" />
          <div className="h-3.5 w-1/3 animate-pulse rounded bg-secondary" />
          <div className="ml-auto h-2.5 w-16 animate-pulse rounded bg-secondary" />
          <div className="hidden h-2.5 w-20 animate-pulse rounded bg-secondary md:block" />
        </div>
      ))}
    </div>
  );
}
