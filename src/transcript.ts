// Transcript model + stable chat-identity derivation (PRD "Hard safety
// constraints" §2, §3).
//
// The single most important safety property of this package: a captured chat is
// keyed on a DETERMINISTIC id derived from (source + workspace + ide_session_id)
// so the SAME IDE session always maps to the SAME server record. That gives the
// app "your conversation is right there, updated, no duplicates" — re-syncing a
// session UPDATES in place instead of creating a new chat every turn.
//
// The IDE's own chat title is carried as DISPLAY metadata only; it is never the
// identity key (titles change and collide).
//
// Zero runtime deps — Node built-ins only.
import { createHash } from "node:crypto";

/** Sources we can capture from. OpenCode is reserved but not yet supported. */
export type SyncSource = "cursor" | "claude_code" | "opencode";

/** One message in a captured transcript. Content is verbatim markdown. */
export interface TranscriptMessage {
  /** Logical role. Unknown roles are normalised to "assistant" upstream. */
  role: "user" | "assistant" | "system" | "tool";
  /** Verbatim markdown/text exactly as the IDE stored it (no re-formatting). */
  content: string;
  /** Optional ISO timestamp when the IDE recorded it. */
  ts?: string;
}

/** A fully-captured, ready-to-upload transcript for ONE IDE session. */
export interface CapturedTranscript {
  /** Which IDE produced it. */
  source: SyncSource;
  /** The IDE's per-session id (Cursor conversation id / Claude session id). */
  ide_session_id: string;
  /** Absolute workspace path the session ran in (part of the identity hash). */
  workspace_path: string;
  /** Friendly repo/project label for display (NOT part of the identity). */
  project?: string;
  /** The IDE's chat title, if any — DISPLAY metadata only. */
  title?: string;
  /** Ordered messages (oldest first), verbatim markdown. */
  messages: TranscriptMessage[];
}

/**
 * Derive the stable `external_chat_id` for a session (PRD §2). Same
 * (source, workspace_path, ide_session_id) → same id forever → server updates
 * in place. Returns a 32-hex-char sha256 prefix (collision-safe for this use).
 *
 * We lowercase the source + path so trivial case differences don't fork an id,
 * but we keep the session id verbatim (IDE-controlled, already canonical).
 */
export function deriveExternalChatId(input: {
  source: SyncSource;
  workspace_path: string;
  ide_session_id: string;
}): string {
  const basis = [
    input.source.toLowerCase().trim(),
    input.workspace_path.toLowerCase().trim(),
    input.ide_session_id.trim(),
  ].join("\u0000"); // NUL separator — cannot appear in any of the parts
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

/** Normalise an arbitrary role string to one of the known roles. */
export function normaliseRole(raw: unknown): TranscriptMessage["role"] {
  const r = typeof raw === "string" ? raw.toLowerCase() : "";
  if (r === "user" || r === "human") return "user";
  if (r === "system") return "system";
  if (r === "tool" || r === "tool_result" || r === "function") return "tool";
  return "assistant";
}
