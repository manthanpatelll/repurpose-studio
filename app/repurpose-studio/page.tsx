"use client";

// ===========================================================================
// REPURPOSE STUDIO  --  /repurpose-studio  (PROJECTS HUB)
// ===========================================================================
// This route is now the Descript-style PROJECTS HUB: a grid/list of every reel
// project with a "New Project" CTA. The actual NLE editor moved to
// app/repurpose-studio/[projectId]/page.tsx -- opening a project card navigates
// there. All hub UI lives in ./_hub; this file is just the thin client shell.
// ===========================================================================

import { RepurposeHub } from "./_hub/RepurposeHub";

export default function RepurposeStudioHubPage() {
  return <RepurposeHub />;
}
