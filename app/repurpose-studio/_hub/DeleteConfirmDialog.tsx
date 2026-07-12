// ===========================================================================
// Repurpose Studio hub -- DeleteConfirmDialog
// ===========================================================================
// Confirms a destructive project delete. Open when `project` is non-null; the
// parent owns the pendingDelete state and clears it via onCancel / onConfirm.
// ===========================================================================

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ProjectMeta } from "./types";

export function DeleteConfirmDialog({
  project,
  onConfirm,
  onCancel,
}: {
  project: ProjectMeta | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={project !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="dark">
        <DialogHeader>
          <DialogTitle>Delete &ldquo;{project?.name}&rdquo;?</DialogTitle>
          <DialogDescription>
            This permanently removes the project. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
