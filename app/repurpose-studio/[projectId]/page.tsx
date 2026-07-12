"use client";

// ===========================================================================
// REPURPOSE STUDIO  --  /repurpose-studio/[projectId]  (the EDITOR)
// ===========================================================================
// Thin per-project route wrapper. The whole NLE lives in <RepurposeEditor>
// (../_components/RepurposeEditor); this file only reads the project id off the
// route and hands it down. The id is either a real dated slug
// (e.g. "claude-routines-automation-13-jul-26", loaded from disk) or a
// provisional "new-<rand>" id minted by the hub's "New Project" button (a blank
// editor that auto-creates + router.replaces to its dated slug once a name
// derives from the transcript). All of that lifecycle lives in
// useProjectPersistence(projectId), invoked inside RepurposeEditor.
// ===========================================================================

import { useParams } from "next/navigation";
import { RepurposeEditor } from "../_components/RepurposeEditor";

export default function RepurposeEditorPage() {
  const params = useParams<{ projectId: string }>();
  // useParams returns the decoded segment synchronously on the first client
  // render for a dynamic route, so projectId is defined before the editor's
  // effects run. Guard the (practically impossible) empty case as "new".
  const projectId = params?.projectId || "new";
  return <RepurposeEditor projectId={projectId} />;
}
