// Cursor capture adapter (PRD "Per-IDE capture adapters").
//
// SAFETY + STABILITY: Cursor persists chat history in private, undocumented
// SQLite blobs that change shape between releases. The PRD is explicit: PREFER
// the id/transcript the hook is HANDED over reverse-engineering the private
// store. So this adapter consumes the Cursor `stop` hook's stdin payload (which
// Cursor provides to hooks) and extracts the current conversation from it. We do
// NOT open Cursor's SQLite or walk its storage — that would be both brittle and
// the exact "read everything" behaviour the PRD forbids.
//
// If the hook payload does not carry conversation content (older Cursor, or a
// payload shape we don't recognise), we return null → nothing is synced for
// that turn (fail-safe, never throw, never guess).
//
// Zero runtime deps — Node built-ins only.
import path from "node:path";
import {
  normaliseRole,
  type CapturedTranscript,
  type TranscriptMessage,
} from "../transcript.js";

/** The (best-effort) shape of Cursor's stop-hook stdin payload we consume. */
export interface CursorHookPayload {
  /** Stable per-conversation id Cursor assigns. */
  conversation_id?: string;
  conversationId?: string;
  /** Workspace root. */
  workspace_path?: string;
  workspaceRoots?: string[];
  cwd?: string;
  /** Optional conversation title. */
  title?: string;
  /** Messages, under one of several keys Cursor has used. */
  messages?: unknown;
  conversation?: unknown;
  transcript?: unknown;
}

function firstString(...vals: Array<unknown>): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

/** Coerce one raw message-ish object into a {@link TranscriptMessage}. */
function coerceMessage(raw: unknown): TranscriptMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // content may be `content`, `text`, or an array of `{text}` blocks.
  let content = "";
  if (typeof r.content === "string") content = r.content;
  else if (typeof r.text === "string") content = r.text;
  else if (Array.isArray(r.content)) {
    content = r.content
      .map((b) => (typeof b === "string" ? b : (b as Record<string, unknown>)?.text))
      .filter((s): s is string => typeof s === "string")
      .join("\n")
      .trim();
  }
  if (!content) return null;
  const msg: TranscriptMessage = { role: normaliseRole(r.role ?? r.type), content };
  if (typeof r.timestamp === "string") msg.ts = r.timestamp;
  return msg;
}

/** Pull a messages array out of the payload under any of the keys Cursor uses. */
function extractMessages(payload: CursorHookPayload): TranscriptMessage[] {
  const candidates: unknown[] = [];
  for (const key of ["messages", "conversation", "transcript"] as const) {
    const v = payload[key];
    if (Array.isArray(v)) candidates.push(...v);
    else if (v && typeof v === "object" && Array.isArray((v as Record<string, unknown>).messages)) {
      candidates.push(...((v as Record<string, unknown>).messages as unknown[]));
    }
  }
  const out: TranscriptMessage[] = [];
  for (const c of candidates) {
    const m = coerceMessage(c);
    if (m) out.push(m);
  }
  return out;
}

/**
 * Capture the CURRENT Cursor conversation from the stop-hook payload. Returns
 * null when the payload carries no recognisable conversation (fail-safe).
 * `fallbackCwd` is used for the workspace path when the payload omits it.
 */
export function captureCursor(
  payload: CursorHookPayload,
  fallbackCwd: string = process.cwd(),
): CapturedTranscript | null {
  const sessionId = firstString(payload.conversation_id, payload.conversationId);
  if (!sessionId) return null; // no stable id → cannot key a stable chat, skip

  const messages = extractMessages(payload);
  if (messages.length === 0) return null;

  const workspace = firstString(
    payload.workspace_path,
    payload.workspaceRoots?.[0],
    payload.cwd,
    fallbackCwd,
  )!;

  return {
    source: "cursor",
    ide_session_id: sessionId,
    workspace_path: path.resolve(workspace),
    title: firstString(payload.title),
    messages,
  };
}
