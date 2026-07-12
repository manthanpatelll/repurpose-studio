"use client";

// ===========================================================================
// REPURPOSE STUDIO  --  /repurpose-studio
// ===========================================================================
// Turns a raw face-cam + frame-locked screen recording (a long-form YouTube
// video) into a short-form vertical Reel by clipping out retakes. This file
// owns the PAGE SHELL laid out like a real NLE (Descript / Premiere / CapCut):
//
//   +----------------------------------------------------------------------+
//   |  TOP APP BAR  (FilmSlate · Short selector · duration · Export MP4)    |
//   +--------------+----------------------------------+--------------------+
//   |              |          PREVIEW (9:16)          |                    |
//   |  TRANSCRIPT  |        centered, reads big       |     INSPECTOR      |
//   |     RAIL     |                                  |   (Color Adjust)   |
//   |  (ingest +   |                                  |   grading rail     |
//   |  take list)  |                                  |                    |
//   +--------------+----------------------------------+--------------------+
//   | TIMELINE  -- transport bar (play/pause·step·in/out·loop) in its      |
//   |             toolbar + zoom, then the scrubbable tracks (docked)      |
//   +----------------------------------------------------------------------+
//
// Persistence + refresh-guard are mounted at the page root via
// useProjectPersistence: the store is in-memory, so the hook autosaves a
// snapshot to sessionStorage, restores it on reload, and warns before an
// accidental refresh. Restored footage uses dead blob: URLs, so when
// footageNeedsReimport is true we surface a gentle banner asking Manthan to
// re-select his Screen + Face video files to reconnect playback.
//
// Export produces MP4 via lib/repurpose/export-short.ts (WebCodecs +
// Mediabunny) -- this project has no ProRes/.mov encoder -- and now carries the
// face/screen color grades so the exported MP4 matches the graded preview.
//
// State lives in lib/repurpose/store.ts (useRepurposeStore) and the shared
// contract types in lib/repurpose/types.ts (Clip, FaceFraming, Word,
// Take, FootageMeta).
// ===========================================================================

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Export, FilmSlate, Warning, Info, CaretDown, GridNine, ArrowLeft } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRepurposeStore } from "@/lib/repurpose/store";
import { exportShort, type ExportResolution } from "@/lib/repurpose/export-short";
import { PreviewCanvas } from "./PreviewCanvas";
import { Timeline } from "./Timeline";
import { TranscriptPanel } from "./TranscriptPanel";
import { FilesPanel } from "./FilesPanel";
import { SourcesPanel } from "./SourcesPanel";
import { ColorAdjustPanel } from "./ColorAdjustPanel";
import { CaptionPanel } from "./CaptionPanel";
import { MusicPanel } from "./MusicPanel";
import { SfxPanel } from "./SfxPanel";
import { useProjectPersistence } from "./useProjectPersistence";
import { useBlockBrowserZoom } from "./useBlockBrowserZoom";
import { useOverlayPaste } from "./useOverlayPaste";
import { slugifyName } from "./naming";

// ---------------------------------------------------------------------------
// Placeholder Shorts list for the top-bar selector. Real data (per-Short
// footage + transcript + clip state) is wired up once the project/footage
// loader lands -- this keeps the shell functional and reviewable standalone.
// ---------------------------------------------------------------------------
const SHORT_OPTIONS = [
  { id: "short-1", label: "Untitled Short 1" },
];

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// Auto-naming (deriveShortTitle / slugifyName / datedSlug) now lives in
// ./naming.ts, shared with useProjectPersistence, which owns deriving + locking
// the project name and minting its dated-slug id on auto-create. The editor just
// reads the resolved `projectName` back out of useProjectPersistence(projectId).

// ---------------------------------------------------------------------------
// CENTER stage -- the 9:16 preview reads big and crisp, with the transport bar
// docked directly beneath it (play/pause + shortcuts sit right under the video,
// like every real editor). The whole column scrolls if the viewport is short.
// ---------------------------------------------------------------------------

function PreviewPanel() {
  return (
    <div
      id="preview-panel"
      // Backdrop AROUND the 9:16 preview is a very dark cherry red (not the app's
      // navy/near-black bg-background), so the flat preview reads as a deliberate
      // stage. The canvas itself stays pure black (the real reel fill).
      className="flex h-full min-h-0 flex-col items-center justify-center bg-[#1F0608] p-6"
    >
      {/* The 9:16 preview is HEIGHT-constrained so it never overflows the
          column (which is what pushed the FACE half past the timeline before).
          The wrapper is h-full with a 9:16 aspect-ratio, so the browser derives
          its WIDTH from the available height -- capped at 340px on tall
          viewports. PreviewCanvas (w-full + its own ratio) then fills it.
          min-h-0 lets the flex child actually shrink to the column height.
          The framing "how it works" copy lives in the Inspector (an ⓘ fold) so
          it never eats the center canvas -- see FramingHelp below. */}
      <div className="flex min-h-0 w-full flex-1 items-center justify-center">
        <div className="relative h-full max-w-[340px] shrink" style={{ aspectRatio: "9 / 16" }}>
          <PreviewCanvas className="!h-full" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Framing help -- the "how pan/zoom + scenes work" copy, moved OFF the center
// canvas (where it was eating the preview column) into a collapsible Inspector
// fold. Collapsed by default (space-friendly); an ⓘ header toggles it open.
// ---------------------------------------------------------------------------

function FramingHelp() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="flex items-center gap-1.5">
          <Info size={14} weight="bold" className="text-[#FF6B35]" />
          How framing works
        </span>
        <CaretDown
          size={13}
          weight="bold"
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
          Drag the coral handle to adjust the split. Drag or scroll inside a
          region to reframe the CURRENT scene -- one static framing per scene, no
          keyframes -- and at each cut the picture eases to the next scene&apos;s
          framing with a smart transition. Press{" "}
          <kbd className="rounded border border-border bg-secondary px-1 py-0.5 text-[10px] font-medium text-foreground">
            /
          </kbd>{" "}
          to split a scene into color-coded sub-scenes, each with its own framing.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RIGHT inspector rail -- where grading lives. Its own header, scrolls
// vertically if content overflows, mirrors the transcript rail's fixed width.
// ---------------------------------------------------------------------------

function InspectorRail() {
  return (
    <div
      id="inspector-panel"
      className="flex h-full flex-col border-l border-border bg-card"
    >
      <div className="flex h-11 shrink-0 items-center border-b border-border px-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Inspector
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {/* Footage / transcript ingest -- prominent while footage is missing,
            collapses to a "Re-import footage" fold once it's loaded. Owns the
            demo auto-load + caption backfill on mount. */}
        <FilesPanel />
        <div className="mt-6 border-t border-border pt-4">
          <SourcesPanel />
        </div>
        <div className="mt-6 border-t border-border pt-4">
          <ColorAdjustPanel />
        </div>
        <div className="mt-6 border-t border-border pt-4">
          <CaptionPanel />
        </div>
        <div className="mt-6 border-t border-border pt-4">
          <MusicPanel />
        </div>
        <div className="mt-6 border-t border-border pt-4">
          <SfxPanel />
        </div>
        <div className="mt-6 border-t border-border pt-4">
          <FramingHelp />
        </div>
      </div>
    </div>
  );
}

function TimelinePanel() {
  return (
    <div
      id="timeline-panel"
      className="flex h-full flex-col border-t border-border bg-card p-2"
    >
      <Timeline className="flex-1 min-h-0" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function TopBar({
  shortOptions,
  selectedShortId,
  onSelectShort,
  durationLabel,
  onExport,
  exporting,
  exportProgress,
  resolution,
  onResolutionChange,
  onBackToHub,
}: {
  shortOptions: { id: string; label: string }[];
  selectedShortId: string;
  onSelectShort: (id: string) => void;
  durationLabel: string;
  onExport: () => void;
  exporting: boolean;
  /** Navigate back to the projects hub (/repurpose-studio). */
  onBackToHub: () => void;
  /**
   * Live export state, or null when idle. `label` is the human phase
   * ("Rendering", "Encoding", ...) and `pct` is 0-100. Rendered on the
   * Export button as a filling coral bar + percent so a multi-minute export
   * shows real progress instead of a frozen "Exporting..." string.
   */
  exportProgress: { label: string; pct: number } | null;
  resolution: ExportResolution;
  onResolutionChange: (r: ExportResolution) => void;
}) {
  const showGrid = useRepurposeStore((s) => s.showGrid);
  const toggleGrid = useRepurposeStore((s) => s.toggleGrid);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-4">
      <div className="flex items-center gap-3">
        {/* Back to the projects hub -- leaves the editor for the gallery of all
            projects. The current project autosaves to disk, so nothing is lost. */}
        <button
          type="button"
          onClick={onBackToHub}
          title="Back to all projects"
          aria-label="Back to all projects"
          className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft size={15} weight="bold" />
          Projects
        </button>
        <FilmSlate size={20} weight="fill" className="text-primary" />
        <h1 className="text-sm font-semibold tracking-wide text-foreground">
          REPURPOSE STUDIO <span className="text-muted-foreground">--</span>{" "}
          skills <span className="text-muted-foreground">·</span> Manthan Patel
        </h1>

        {/* Alignment grid toggle -- rule-of-thirds + center crosshair on the
            preview to eyeball-center a layer. Coral when on. */}
        <button
          type="button"
          onClick={toggleGrid}
          aria-pressed={showGrid}
          title={showGrid ? "Hide alignment grid" : "Show alignment grid (center guides)"}
          aria-label="Toggle alignment grid"
          className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
            showGrid
              ? "border-primary/60 bg-primary/15 text-primary"
              : "border-border bg-secondary text-muted-foreground hover:text-foreground"
          }`}
        >
          <GridNine size={15} weight={showGrid ? "fill" : "bold"} />
          Grid
        </button>
      </div>

      <div className="flex items-center gap-3">
        <Select value={selectedShortId} onValueChange={onSelectShort}>
          <SelectTrigger size="sm" className="w-48" aria-label="Select Short">
            <SelectValue placeholder="Select a Short" />
          </SelectTrigger>
          <SelectContent>
            {shortOptions.map((opt) => (
              <SelectItem key={opt.id} value={opt.id}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-medium tabular-nums text-foreground">
          {durationLabel}
        </div>

        {/* Resolution toggle -- segmented 1080p / 4K. Disabled mid-export so
            the size can't change under a running encode. Both are 9:16; 4K
            upscales (source is ~1080) for crisper edges at a larger file. */}
        <div
          role="group"
          aria-label="Export resolution"
          className="flex items-center overflow-hidden rounded-md border border-border bg-secondary text-xs font-medium"
        >
          {(["1080p", "4k"] as const).map((r) => {
            const active = resolution === r;
            return (
              <button
                key={r}
                type="button"
                onClick={() => onResolutionChange(r)}
                disabled={exporting}
                aria-pressed={active}
                className={`px-2.5 py-1.5 tabular-nums transition-colors disabled:opacity-50 ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {r === "1080p" ? "1080p" : "4K"}
              </button>
            );
          })}
        </div>

        <Button
          size="sm"
          onClick={onExport}
          disabled={exporting}
          className="relative min-w-[150px] gap-1.5 overflow-hidden"
        >
          {/* Progress fill -- a translucent bar that grows left-to-right behind
              the label while exporting. Sits under the content (z-0) so the
              icon + text stay crisp on top. */}
          {exportProgress && (
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 z-0 bg-white/25 transition-[width] duration-200 ease-out"
              style={{ width: `${exportProgress.pct}%` }}
            />
          )}
          <span className="relative z-10 flex items-center gap-1.5 tabular-nums">
            <Export size={16} weight="bold" />
            {exportProgress
              ? `${exportProgress.label} ${exportProgress.pct}%`
              : "Export MP4"}
          </span>
        </Button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Map the exporter's status enum to a short human label for the button. */
const EXPORT_STATUS_LABEL: Record<string, string> = {
  preparing: "Preparing",
  rendering: "Rendering",
  encoding: "Encoding",
  complete: "Finishing",
  error: "Exporting",
};

export function RepurposeEditor({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [selectedShortId, setSelectedShortId] = useState(SHORT_OPTIONS[0].id);
  const [exporting, setExporting] = useState(false);
  // Live export progress ({label, pct}) or null when idle. Drives the Export
  // button's fill bar + percent readout.
  const [exportProgress, setExportProgress] = useState<{
    label: string;
    pct: number;
  } | null>(null);
  // Last export error message, or null. Surfaced as a dismissible banner so a
  // failed export is visible instead of only hitting the console.
  const [exportError, setExportError] = useState<string | null>(null);
  // Chosen output resolution. Default 1080p (standard Reel delivery); 4K
  // upscales for platforms that keep more of the source.
  const [resolution, setResolution] = useState<ExportResolution>("1080p");
  const duration = useRepurposeStore((s) => s.duration);

  // Per-project disk persistence: loads THIS project (by route id) on mount,
  // debounce-autosaves edits to disk, auto-creates the dated-slug project on the
  // first real content and router.replaces the URL to it. Returns the resolved
  // project name (derived from the transcript, then frozen) and
  // `footageNeedsReimport` (true when restored footage used dead blob: URLs).
  const { footageNeedsReimport, projectName } = useProjectPersistence(projectId);

  // Build the selector options: each Short reads "<Project Title> · Short N".
  // Before a transcript loads there's no title yet, so fall back to the plain
  // "Untitled Short N" placeholder. The base title is shared across all Shorts.
  const shortOptions = useMemo(
    () =>
      SHORT_OPTIONS.map((opt, i) => ({
        id: opt.id,
        label: projectName ? `${projectName} · Short ${i + 1}` : opt.label,
      })),
    [projectName]
  );

  // Block Chrome's page zoom (ctrl/cmd+wheel, trackpad pinch, cmd+=/-/0) while
  // the studio is open -- zooming the timeline must never also zoom the app.
  // React's root wheel listener is passive, so this needs the native
  // non-passive document listener inside the hook.
  useBlockBrowserZoom();

  // Paste an image/video from the clipboard -> overlay at the playhead. Gated
  // off inputs / textareas / contentEditable / the transcript panel so a normal
  // text paste there still runs natively.
  useOverlayPaste();

  const durationLabel = useMemo(() => formatDuration(duration), [duration]);

  const handleExport = useCallback(async () => {
    // Pull the current editor state and run the real MP4 export
    // (compositor drawFrame -> videoExporter -> download). This pipeline
    // produces MP4 (H.264/HEVC via WebCodecs), not ProRes/.mov.
    const state = useRepurposeStore.getState();
    if (state.duration <= 0 || exporting) return;
    // Name the downloaded MP4 after the Short's derived label (e.g.
    // "claude-routines-automation-short-1.mp4"), falling back to the id.
    const selectedLabel =
      shortOptions.find((o) => o.id === selectedShortId)?.label ?? selectedShortId;
    const exportStem = slugifyName(selectedLabel) || selectedShortId;
    setExporting(true);
    setExportError(null);
    setExportProgress({ label: "Preparing", pct: 0 });
    try {
      const result = await exportShort({
        clips: state.clips,
        duration: state.duration,
        splitRatio: state.splitRatio,
        footageMeta: state.footageMeta,
        // Free-floating overlays baked ON TOP of the base composite at export
        // time (image + video, in their own output-time windows, z-ordered).
        // Overlays are ALWAYS silent -- their audio is never mixed in.
        overlays: state.overlays,
        faceGrade: state.faceGrade,
        screenGrade: state.screenGrade,
        captionsEnabled: state.captionsEnabled,
        captionStyle: state.captionStyle,
        captionBlocks: state.captionBlocks,
        // Generated sound-effects track (a full-length WAV) mixed into the export
        // audio alongside the face-cam. Null when none was generated.
        sfxTrack: state.sfxTrack,
        musicTrack: state.musicTrack,
        resolution,
        fileName: `${exportStem}${resolution === "4k" ? "-4k" : ""}.mp4`,
        onProgress: (p) => {
          setExportProgress({
            label: EXPORT_STATUS_LABEL[p.status] ?? "Exporting",
            pct: Math.round(p.progress),
          });
        },
      });
      // exportShort returns null when there's nothing to export (duration 0);
      // the click guard above already covers that, so a null here is unexpected.
      if (result === null) {
        setExportError("Export produced no output. Check that footage is loaded.");
      }
    } catch (err) {
      console.error("Repurpose export failed:", err);
      setExportError(
        err instanceof Error ? err.message : "Export failed. See console for details."
      );
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  }, [exporting, selectedShortId, resolution, shortOptions]);

  return (
    // FIXED SHELL: position:fixed + inset-0 takes the editor out of document
    // flow entirely, so the body has no scrollable height -- the page can never
    // scroll down past the docked timeline no matter what a stray element,
    // focus() call, or scrollIntoView tries. (h-dvh alone still let the
    // document scroll when anything nudged it.) overscroll-none kills the
    // rubber-band bounce on trackpads too.
    <div className="fixed inset-0 flex flex-col overflow-hidden overscroll-none bg-background text-foreground dark">
      <TopBar
        shortOptions={shortOptions}
        selectedShortId={selectedShortId}
        onSelectShort={setSelectedShortId}
        durationLabel={durationLabel}
        onExport={handleExport}
        exporting={exporting}
        exportProgress={exportProgress}
        resolution={resolution}
        onResolutionChange={setResolution}
        onBackToHub={() => router.push("/repurpose-studio")}
      />

      {/* Export-error banner -- dismissible. Shown when an export throws or
          produces no output, so a failure is visible instead of console-only. */}
      {exportError && (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2.5 border-b border-red-500/40 bg-red-500/10 px-4 py-2.5 text-xs text-red-300"
        >
          <Warning size={16} weight="fill" className="mt-px shrink-0 text-red-500" />
          <p className="flex-1 leading-relaxed">
            <span className="font-semibold">Export failed.</span> {exportError}
          </p>
          <button
            type="button"
            onClick={() => setExportError(null)}
            className="shrink-0 rounded px-1.5 py-0.5 font-medium text-red-300 hover:bg-red-500/20"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Reconnect-footage banner -- gentle, non-blocking. Shown only when a
          restored project's footage used dead blob: URLs after a reload. */}
      {footageNeedsReimport && (
        <div
          role="status"
          className="flex shrink-0 items-start gap-2.5 border-b border-[#FF6B35]/30 bg-[#FF6B35]/10 px-4 py-2.5 text-xs text-[#FF8F6B]"
        >
          <Warning size={16} weight="fill" className="mt-px shrink-0 text-[#FF6B35]" />
          <p className="leading-relaxed">
            Your project was restored. Re-select your Screen and Face video
            files in the Sources panel (Inspector) to reconnect playback.{" "}
            <span className="text-muted-foreground">
              (Footage details, transcript, and timeline all survived the
              reload -- only the video sources need reattaching.)
            </span>
          </p>
        </div>
      )}

      {/* Main work area -- transcript rail | preview + transport | inspector.
          Each column is min-h-0 + overflow-hidden so a tall child (the full
          transcript, the inspector rail) scrolls INSIDE its own column instead
          of growing the row past the viewport and pushing the docked timeline
          below the fold (which left dead space under it). */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="flex w-72 min-h-0 shrink-0 flex-col overflow-hidden border-r border-border">
          <TranscriptPanel />
        </aside>

        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <PreviewPanel />
        </main>

        <aside className="flex w-80 min-h-0 shrink-0 flex-col overflow-hidden">
          <InspectorRail />
        </aside>
      </div>

      {/* Timeline docked full-width along the bottom -- always the last thing on
          the page, never pushed below a scroll. */}
      <div className="h-60 min-h-0 shrink-0 overflow-hidden">
        <TimelinePanel />
      </div>
    </div>
  );
}
