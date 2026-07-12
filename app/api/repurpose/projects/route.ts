import 'server-only';

import { NextRequest, NextResponse } from 'next/server';

import {
  isValidProjectId,
  listProjects,
  readProject,
  uniqueId,
  writeProject,
  type ProjectFile,
} from '@/lib/repurpose/projects';
import type { ProjectSnapshot } from '@/lib/repurpose/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET -> list all projects as lightweight metadata (newest-first).
export async function GET() {
  return NextResponse.json({ projects: listProjects() });
}

interface PostBody {
  id?: unknown;
  name?: unknown;
  snapshot?: unknown;
  createdAt?: unknown;
  durationSec?: unknown;
  /**
   * "create" forces a brand-new project: the id is ALWAYS run through uniqueId,
   * so a create whose derived slug collides with an existing project becomes
   * <id>-2 instead of overwriting it. Anything else (the default) is an autosave
   * upsert that writes the given id in place. The client sends mode:"create" only
   * on the first save of a new project, then autosaves without it.
   */
  mode?: unknown;
}

// POST -> create or upsert a project.
//   - mode:"create" -> ALWAYS collision-suffix the id via uniqueId, so a new
//     project can never overwrite an existing one even if its derived slug
//     (name+date) matches. Two same-day same-name creates become <id> and <id>-2.
//   - otherwise (autosave) -> upsert the given id in place (idempotent re-save).
// The returned id is authoritative (may be suffixed) and the client trusts it.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as PostBody;

  if (!isValidProjectId(body.id)) {
    return NextResponse.json({ error: 'valid id required' }, { status: 400 });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }
  if (!body.snapshot || typeof body.snapshot !== 'object') {
    return NextResponse.json(
      { error: 'snapshot object required' },
      { status: 400 },
    );
  }

  const snapshot = body.snapshot as ProjectSnapshot;
  const now = new Date().toISOString();

  const durationSec =
    typeof body.durationSec === 'number' && Number.isFinite(body.durationSec)
      ? body.durationSec
      : typeof snapshot.duration === 'number'
        ? snapshot.duration
        : 0;

  const isCreate = body.mode === 'create';

  // On a CREATE, always resolve a collision-free id (uniqueId) so a new project
  // can never overwrite an existing file, even when its derived slug matches.
  // On an autosave, upsert the given id (reuse the existing file if present).
  const existing = isCreate ? null : readProject(body.id);
  const id = isCreate ? uniqueId(body.id) : existing ? body.id : uniqueId(body.id);

  // Preserve the original createdAt on re-save; else prefer the client's
  // provided createdAt (if a non-empty string), else stamp now.
  const createdAt = existing
    ? existing.createdAt
    : typeof body.createdAt === 'string' && body.createdAt.trim()
      ? body.createdAt
      : now;

  const file: ProjectFile = {
    id,
    name,
    createdAt,
    updatedAt: now,
    durationSec,
    snapshot,
  };
  writeProject(file);

  return NextResponse.json({
    project: {
      id: file.id,
      name: file.name,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      durationSec: file.durationSec,
    },
  });
}
