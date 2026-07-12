import 'server-only';

// ===========================================================================
// lib/repurpose/projects.ts  —  disk-backed project store for Repurpose Studio
// ===========================================================================
// Each project is one JSON file under ~/Downloads/repurpose-projects named
// <id>.json. The id IS the filename stem, so ID_RE below is the ONLY security
// gate we need: it forbids `/`, `\`, `.`, `..`, and any traversal, and we only
// ever touch our OWN fixed PROJECTS_DIR. Because the dir is fixed and the id is
// regex-clamped to a single path segment, there is no way to escape it, so NO
// realpath allow-list is needed here (unlike /api/repurpose/asset, which serves
// arbitrary user-picked absolute paths). Node runtime required for fs.
// ===========================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProjectSnapshot } from './types';

export const PROJECTS_DIR = path.join(
  os.homedir(),
  'Downloads',
  'repurpose-projects',
);

// Single path segment: lowercase alnum start, then alnum/hyphen, 1..100 chars.
// Forbids `/ \ . ..` and traversal because none of those characters match.
const ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

export function isValidProjectId(id: unknown): id is string {
  return (
    typeof id === 'string' && ID_RE.test(id) && path.basename(id) === id
  );
}

export interface ProjectFile {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  durationSec: number;
  snapshot: ProjectSnapshot;
}

export type ProjectMeta = Pick<
  ProjectFile,
  'id' | 'name' | 'createdAt' | 'updatedAt' | 'durationSec'
>;

function ensureDir(): void {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

function filePath(id: string): string {
  return path.join(PROJECTS_DIR, `${id}.json`);
}

/**
 * Read + JSON.parse + shape-validate a project file. Returns null on any
 * failure (missing, unreadable, invalid JSON, wrong shape) so callers never
 * throw on a corrupt or partial file on disk.
 */
function readFileSafe(fp: string): ProjectFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(fp, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (!isValidProjectId(p.id)) return null;
  if (typeof p.name !== 'string') return null;
  if (typeof p.createdAt !== 'string') return null;
  if (typeof p.updatedAt !== 'string') return null;
  if (typeof p.durationSec !== 'number') return null;
  if (!p.snapshot || typeof p.snapshot !== 'object') return null;
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    durationSec: p.durationSec,
    snapshot: p.snapshot as ProjectSnapshot,
  };
}

/**
 * List all valid projects as lightweight metadata (no snapshot), sorted
 * newest-first by updatedAt. Corrupt/misshaped files are silently skipped.
 * ISO strings sort lexicographically == chronologically, so newest-first is
 * `b.updatedAt` before `a.updatedAt`.
 */
export function listProjects(): ProjectMeta[] {
  ensureDir();
  let names: string[];
  try {
    names = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return [];
  }
  const metas: ProjectMeta[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const stem = name.slice(0, -'.json'.length);
    if (!isValidProjectId(stem)) continue;
    const file = readFileSafe(path.join(PROJECTS_DIR, name));
    if (!file) continue;
    metas.push({
      id: file.id,
      name: file.name,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      durationSec: file.durationSec,
    });
  }
  metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return metas;
}

/** Read a full project by id. Invalid id, or missing/corrupt file -> null. */
export function readProject(id: string): ProjectFile | null {
  if (!isValidProjectId(id)) return null;
  ensureDir();
  return readFileSafe(filePath(id));
}

/** Upsert a project file, last-write-wins. */
export function writeProject(file: ProjectFile): void {
  ensureDir();
  fs.writeFileSync(
    filePath(file.id),
    JSON.stringify(file, null, 2) + '\n',
    'utf8',
  );
}

/**
 * Delete a project file. Returns whether a file was actually removed. No-op
 * (false) if the id is invalid or the file is already absent.
 */
export function deleteProject(id: string): boolean {
  if (!isValidProjectId(id)) return false;
  ensureDir();
  const fp = filePath(id);
  if (!fs.existsSync(fp)) return false;
  try {
    fs.unlinkSync(fp);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return `base` if no <base>.json exists yet, else the first free
 * `base-2`, `base-3`, ... Caps the scan to avoid an unbounded loop and falls
 * back to a timestamp-suffixed id if somehow every slot is taken (Date.now is
 * fine here -- this runs inside a Node route, not a deterministic workflow).
 */
export function uniqueId(base: string): string {
  ensureDir();
  if (!fs.existsSync(filePath(base))) return base;
  for (let n = 2; n <= 10000; n++) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(filePath(candidate))) return candidate;
  }
  return `${base}-${Date.now()}`;
}
