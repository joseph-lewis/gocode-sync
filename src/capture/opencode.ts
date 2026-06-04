// OpenCode capture adapter (PRD "Per-IDE capture adapters").
//
// SAFETY + STABILITY: OpenCode persists sessions as JSON files under
// ~/.local/share/opencode/storage/{message,part}/… but that on-disk layout is
// internal and changes between releases. Rather than reverse-engineer it, we
// mirror the Cursor pattern: the OpenCode `session.idle` plugin we install
// fetches ONLY the current session's messages via OpenCode's own stable SDK
// (`client.session.messages({ path: { id } })`) and pipes that JSON to
// `gocode-sync on-sync --source opencode --stdin`. This adapter parses exactly
// that payload. We therefore:
//   - capture ONLY the current session (the plugin passes only the idle
//     session's id; it never lists or reads other sessions), and
//   - keep all parse / redact / upload logic in THIS auditable package, with
//     only a tiny fetch living in the generated plugin.
//
// The SDK's `session.messages()` returns an array of `{ info, parts }` where
// `info` is a Message ({ id, role, time? }) and `parts` is an array of Part
// objects; the conversational text lives in parts of `type: "text"` (`.text`).
// We also accept a couple of lenient fallbacks (a bare `messages` array, or a
// message whose `content` is already a string) so a minor SDK shape change does
// not silently drop everything. Unrecognised payloads → null (fail-safe).
//
// Zero runtime deps — Node built-ins only.
import path from "node:path";
import {
  normaliseRole,
  type CapturedTranscript,
  type TranscriptMessage,
} from "../transcript.js";

/**
 * The payload our generated OpenCode plugin pipes on stdin. `messages` is the
 * verbatim result of `client.session.messages(...)` (data unwrapped). The
 * session id + workspace are passed alongside so we can key a stable chat
 * without reading anything else.
 */
export interface OpenCodeHookPayload {
  /** The idle session's id (from `event.properties.sessionID`). REQUIRED. */
  session_id?: string;
  sessionID?: string;
  /** Workspace/project root the session ran in. */
  workspace_path?: string;
  directory?: string;
  worktree?: string;
  cwd?: string;
  /** Optional session title for display. */
  title?: string;
  /** Result of `client.session.messages()` — `{ info, parts }[]` (preferred). */
  messages?: unknown;
}

function firstString(...vals: Array<unknown>): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

/**
 * Build the synced text from an OpenCode `parts` array: verbatim `text` parts
 * plus a one-line summary (name only) for `tool` parts. `reasoning` and all
 * other part types are intentionally excluded (see the NOTE below).
 */
function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const out: string[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const part = p as Record<string, unknown>;
    // Text parts carry the conversational markdown — this is what the user
    // sees in the chat and is the only content we sync as message text.
    if (part.type === "text" && typeof part.text === "string") {
      out.push(part.text);
    } else if (part.type === "tool" && typeof part.tool === "string") {
      // Summarise tool calls (name only); never reconstruct their internals.
      out.push(`\u200b[tool: ${part.tool}]`);
    }
    // NOTE: `reasoning` parts are deliberately NOT synced. They're the model's
    // hidden/collapsed thinking, which users don't expect uploaded under the
    // "sync my current chat" promise — keep the surface to visible chat only.
  }
  return out.join("\n").trim();
}

/** Coerce one `{ info, parts }` entry (or a lenient fallback) into a message. */
function coerceEntry(raw: unknown): TranscriptMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  // Preferred SDK shape: { info: { role, time? }, parts: Part[] }.
  const info = (r.info && typeof r.info === "object")
    ? (r.info as Record<string, unknown>)
    : r; // fallback: the entry itself looks like a message

  const roleRaw = info.role ?? r.role;

  let content = "";
  if (Array.isArray(r.parts)) content = textFromParts(r.parts);
  else if (typeof info.content === "string") content = info.content;
  else if (typeof r.content === "string") content = r.content;
  else if (typeof r.text === "string") content = r.text;
  content = content.trim();
  if (!content) return null;

  const msg: TranscriptMessage = { role: normaliseRole(roleRaw), content };
  // Best-effort timestamp: SDK `time.created` is epoch ms; accept ISO too.
  const time = info.time;
  if (time && typeof time === "object") {
    const created = (time as Record<string, unknown>).created;
    if (typeof created === "number" && Number.isFinite(created)) {
      msg.ts = new Date(created).toISOString();
    } else if (typeof created === "string") {
      msg.ts = created;
    }
  } else if (typeof info.timestamp === "string") {
    msg.ts = info.timestamp;
  }
  return msg;
}

/** Pull the messages array out of the payload (preferred + lenient fallback). */
function extractMessages(payload: OpenCodeHookPayload): TranscriptMessage[] {
  const raw = payload.messages;
  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).data)
      ? ((raw as Record<string, unknown>).data as unknown[])
      : [];
  const out: TranscriptMessage[] = [];
  for (const e of entries) {
    const m = coerceEntry(e);
    if (m) out.push(m);
  }
  return out;
}

/** Stable reason string callers can log / surface when capture is empty. */
export const OPENCODE_EMPTY_REASON =
  "OpenCode: no current-session messages in the plugin payload (nothing to sync).";

/**
 * Capture the CURRENT OpenCode session from the plugin's piped payload. Returns
 * null when the payload carries no stable session id or no recognisable
 * messages (fail-safe — never throw, never guess). `fallbackCwd` is used for
 * the workspace path when the payload omits it.
 */
export function captureOpenCode(
  payload: OpenCodeHookPayload,
  fallbackCwd: string = process.cwd(),
): CapturedTranscript | null {
  const sessionId = firstString(payload.session_id, payload.sessionID);
  if (!sessionId) return null; // no stable id → cannot key a stable chat

  const messages = extractMessages(payload);
  if (messages.length === 0) return null;

  const workspace = firstString(
    payload.workspace_path,
    payload.directory,
    payload.worktree,
    payload.cwd,
    fallbackCwd,
  )!;

  return {
    source: "opencode",
    ide_session_id: sessionId,
    workspace_path: path.resolve(workspace),
    title: firstString(payload.title),
    messages,
  };
}
