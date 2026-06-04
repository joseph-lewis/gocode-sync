// Claude Code capture adapter (PRD "Per-IDE capture adapters").
//
// SAFETY: captures ONLY the CURRENT session — never enumerates other chats.
// Claude Code persists each session as a JSONL file under
//   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// where <encoded-cwd> is the absolute project path with `/` and `.` replaced by
// `-`. The Stop hook exposes the session id (we read it from the hook payload on
// stdin, or the $CLAUDE_SESSION_ID env that our hook command sets) and the cwd,
// which together point at exactly ONE file. We read that single file and nothing
// else.
//
// Each JSONL line is a record; user/assistant message lines carry
// `{ type, message: { role, content }, timestamp }`. `content` may be a string
// or an array of blocks ({type:"text",text}). We extract verbatim markdown/text
// only — tool-call internals are summarised, not reconstructed.
//
// Zero runtime deps — Node built-ins only.
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveHome, type PathOpts } from "../creds.js";
import {
  normaliseRole,
  type CapturedTranscript,
  type TranscriptMessage,
} from "../transcript.js";

/** Inputs the Stop hook can give us about the CURRENT session. */
export interface ClaudeCaptureInput {
  /** The current session id (from hook stdin `session_id` or $CLAUDE_SESSION_ID). */
  sessionId: string;
  /** The workspace/project cwd the session ran in. */
  cwd: string;
  /** Optional explicit transcript path (hook stdin `transcript_path`), preferred. */
  transcriptPath?: string;
  /** Optional friendly project label for display. */
  project?: string;
}

/** Encode an absolute cwd to Claude's project-dir name (`/`,`.` → `-`). */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** Resolve the single JSONL path for THIS session (current session only). */
export function claudeSessionFile(input: ClaudeCaptureInput, opts?: PathOpts): string {
  if (input.transcriptPath && input.transcriptPath.trim() !== "") {
    return input.transcriptPath;
  }
  return path.join(
    resolveHome(opts),
    ".claude",
    "projects",
    encodeProjectDir(path.resolve(input.cwd)),
    `${input.sessionId}.jsonl`,
  );
}

/** Pull verbatim text out of a Claude `content` field (string or block array). */
function extractContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") parts.push(b.text);
        else if (b.type === "tool_use" && typeof b.name === "string") parts.push(`\u200b[tool: ${b.name}]`);
        else if (b.type === "tool_result") parts.push("\u200b[tool result]");
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}

/** Parse one JSONL line into a {@link TranscriptMessage}, or null to skip. */
function parseLine(line: string): TranscriptMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let rec: unknown;
  try {
    rec = JSON.parse(trimmed);
  } catch {
    return null; // skip unparseable lines, never throw
  }
  if (!rec || typeof rec !== "object") return null;
  const r = rec as Record<string, unknown>;

  // Only user/assistant message records carry conversational content.
  const type = typeof r.type === "string" ? r.type : "";
  if (type !== "user" && type !== "assistant") return null;

  const message = r.message;
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;

  const content = extractContent(m.content);
  if (!content) return null;

  const msg: TranscriptMessage = {
    role: normaliseRole(m.role ?? type),
    content,
  };
  if (typeof r.timestamp === "string") msg.ts = r.timestamp;
  return msg;
}

/**
 * Capture the CURRENT Claude Code session as a {@link CapturedTranscript}.
 * Returns null when the session file does not exist (nothing to sync) — never
 * throws. Reads exactly one file; never lists the projects directory.
 */
export async function captureClaude(
  input: ClaudeCaptureInput,
  opts?: PathOpts,
): Promise<CapturedTranscript | null> {
  const file = claudeSessionFile(input, opts);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null; // any read problem → nothing to sync, stay silent + safe
  }

  const messages: TranscriptMessage[] = [];
  for (const line of raw.split("\n")) {
    const msg = parseLine(line);
    if (msg) messages.push(msg);
  }
  if (messages.length === 0) return null;

  // Best-effort title: first user message's first line, trimmed.
  const firstUser = messages.find((m) => m.role === "user");
  const title = firstUser ? firstUser.content.split("\n")[0].slice(0, 120) : undefined;

  return {
    source: "claude_code",
    ide_session_id: input.sessionId,
    workspace_path: path.resolve(input.cwd),
    project: input.project,
    title,
    messages,
  };
}
