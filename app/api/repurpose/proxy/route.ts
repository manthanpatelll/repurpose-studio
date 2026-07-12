// ===========================================================================
// /api/repurpose/proxy  —  low-res preview-proxy status + build trigger
// ===========================================================================
// WHY THIS EXISTS: the preview <video> wants the low-res dense-keyframe proxy
// built by lib/repurpose/proxy-cache, but an encode takes minutes -- far too
// long to build inline on a video request. So the client drives it in two
// steps: POST here to kick off a background build (returns immediately with
// "building"), then poll GET until "ready", THEN swap the <video> src to
// `/api/repurpose/video?path=...&quality=proxy`. Export never touches this --
// it always reads the original.
//
// SECURITY: same allow-list sandbox as the video route (shared resolveAllowed,
// one validator, one policy). Responses NEVER include server file paths -- the
// client only needs the status; where the proxy lives on disk stays private.
// Node runtime is required for fs/ffmpeg; it cannot run on Edge.
// ===========================================================================

import { stat } from "node:fs/promises";

import { resolveAllowed } from "@/app/api/repurpose/video/route";
import { getProxyState, startProxyBuild, type ProxyState } from "@/lib/repurpose/proxy-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Wire shape: status always, outTimeSec while building. Never proxyPath. */
type ProxyStateJson = {
  status: ProxyState["status"];
  outTimeSec?: number;
};

/** Strip server-private fields (proxyPath) before anything leaves the process. */
function toJson(state: ProxyState): ProxyStateJson {
  return state.outTimeSec !== undefined
    ? { status: state.status, outTimeSec: state.outTimeSec }
    : { status: state.status };
}

/**
 * Validate a raw ?path / body path the exact same way the video route does,
 * then stat it (the proxy cache is keyed by path+mtime+size, so we need the
 * real stats, not client-supplied ones). Null = reject with 404.
 */
async function resolveSource(
  rawPath: string | null
): Promise<{ resolvedPath: string; mtimeMs: number; size: number } | null> {
  if (!rawPath) return null;
  const resolvedPath = await resolveAllowed(rawPath);
  if (!resolvedPath) return null;
  try {
    const info = await stat(resolvedPath);
    if (!info.isFile()) return null;
    return { resolvedPath, mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return null; // vanished between realpath and stat -- treat as not found
  }
}

/** GET ?path=<abs> -> current proxy state (safe to poll, never mutates). */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const src = await resolveSource(url.searchParams.get("path"));
  if (!src) {
    return new Response("Not found or not allowed", { status: 404 });
  }
  const state = await getProxyState(src.resolvedPath, src.mtimeMs, src.size);
  return Response.json(toJson(state));
}

/** POST { path } -> kick off a background build (idempotent), report state. */
export async function POST(request: Request): Promise<Response> {
  // Narrow the body by hand -- request.json() is untyped and we run strict.
  let rawPath: string | null = null;
  try {
    const body: unknown = await request.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "path" in body &&
      typeof (body as { path: unknown }).path === "string"
    ) {
      rawPath = (body as { path: string }).path;
    }
  } catch {
    /* malformed JSON -> rawPath stays null -> 404 below */
  }
  const src = await resolveSource(rawPath);
  if (!src) {
    return new Response("Not found or not allowed", { status: 404 });
  }
  const state = await startProxyBuild(src.resolvedPath, src.mtimeMs, src.size);
  return Response.json(toJson(state));
}
