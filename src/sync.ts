// `gocode-sync on-sync` — the end-of-turn sync dispatcher (PRD "adopted design").
//
// This is the ONE command the runtime stop hooks call ALONGSIDE the notify
// hook. It runs only when @trygocode/sync is installed (the command existing IS
// half the double-gate) AND the server's per-user `ideChatSync.enabled` flag is
// true (the runtime half). Flow:
//
//   1. Gate: fetch the per-user sync setting. If disabled (or unknown) → no-op.
//      This is fail-CLOSED: anything other than an explicit `enabled:true` from
//      the server means we upload NOTHING.
//   2. Capture the CURRENT session only (Cursor from the hook payload; Claude
//      from its per-session JSONL). Never enumerate other chats.
//   3. Sanitise: redact secrets + cap size.
//   4. Upload under the deterministic external_chat_id (update-in-place).
//
// Best-effort + total: NEVER throws, ALWAYS maps to exit 0 (a failed/blocked
// sync must never block the agent's turn — same contract as notify).
//
// Zero runtime deps — Node built-ins only.
import { readCredentials, type PathOpts } from "./creds.js";
import { captureClaude, type ClaudeCaptureInput } from "./capture/claude.js";
import { captureCursor, type CursorHookPayload } from "./capture/cursor.js";
import { captureOpenCode, type OpenCodeHookPayload } from "./capture/opencode.js";
import { sanitiseTranscript } from "./redact.js";
import { uploadTranscript, appendLog, type SyncStatus, type UploadResult } from "./upload.js";
import type { CapturedTranscript, SyncSource } from "./transcript.js";

/** Outcome of {@link onSync}. Always resolved; the caller exits 0. */
export interface OnSyncResult {
  /** What happened, for logging. */
  mode: "uploaded" | "disabled" | "nothing-to-sync" | "not-paired" | "dry-run" | "error";
  /** The upload result, when an upload was attempted. */
  upload?: UploadResult;
  /** Human-readable detail (also logged). */
  detail?: string;
}

/** The per-user setting shape the gate endpoint returns. */
export interface SyncSettings {
  enabled: boolean;
}

export interface OnSyncOptions extends PathOpts {
  /** Which IDE fired the hook. */
  source: SyncSource;
  /** Repo/workspace cwd. Defaults to process.cwd(). */
  cwd?: string;
  /** Resolved server URL (falls back to creds.server). */
  server?: string;
  /** Status to report with the transcript (default "finished"). */
  status?: SyncStatus;
  /** Print what it WOULD do; capture + sanitise but never upload. */
  dryRun?: boolean;
  /** Injectable fetch. */
  fetchImpl?: typeof fetch;
  /** Network timeout (ms). */
  timeoutMs?: number;
  /** Timestamp source for logs. */
  timestamp?: () => string;

  // ── capture inputs ──
  /** Claude: session id + transcript path (from hook stdin / env). */
  claude?: Pick<ClaudeCaptureInput, "sessionId" | "transcriptPath" | "project">;
  /** Cursor: the parsed stop-hook stdin payload. */
  cursor?: CursorHookPayload;
  /** OpenCode: the parsed `session.idle` plugin stdin payload. */
  opencode?: OpenCodeHookPayload;

  // ── injectable dependencies (defaulted to real implementations) ──
  /** Fetch the per-user sync gate. Defaults to {@link fetchSyncSettings}. */
  fetchSettings?: (opts: OnSyncOptions) => Promise<SyncSettings>;
  /** Capture override (tests). */
  captureImpl?: (opts: OnSyncOptions) => Promise<CapturedTranscript | null>;
  /** Upload override (tests). */
  uploadImpl?: typeof uploadTranscript;
  /** Logger. Defaults to appending to ~/.gocode/sync.log. */
  log?: (line: string) => void | Promise<void>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeServer(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Fetch the per-user `ideChatSync.enabled` gate from the server. Fail-CLOSED:
 * any error, timeout, non-2xx, or missing field resolves to `{enabled:false}`
 * so we never upload when we are not certain the user opted in.
 */
export async function fetchSyncSettings(opts: OnSyncOptions): Promise<SyncSettings> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  let creds;
  try {
    creds = await readCredentials(opts);
  } catch {
    return { enabled: false };
  }
  if (!creds) return { enabled: false };

  const server = normalizeServer(opts.server ?? creds.server);
  const url = `${server}/api/v1/ide-chats/settings`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${creds.api_key}` },
      signal: controller.signal,
    });
    if (!res.ok) return { enabled: false };
    const json = (await res.json()) as { enabled?: unknown };
    return { enabled: json?.enabled === true };
  } catch {
    return { enabled: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Default capture: dispatch to the right per-IDE adapter (current session). */
async function defaultCapture(opts: OnSyncOptions): Promise<CapturedTranscript | null> {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.source === "claude_code") {
    if (!opts.claude?.sessionId) return null;
    return captureClaude({ sessionId: opts.claude.sessionId, cwd, transcriptPath: opts.claude.transcriptPath, project: opts.claude.project }, { home: opts.home });
  }
  if (opts.source === "cursor") {
    if (!opts.cursor) return null;
    return captureCursor(opts.cursor, cwd);
  }
  if (opts.source === "opencode") {
    if (!opts.opencode) return null;
    return captureOpenCode(opts.opencode, cwd);
  }
  // anything else → not supported
  return null;
}

/**
 * End-of-turn sync dispatcher. Gated, capture-current-session-only, sanitised,
 * update-in-place upload. NEVER throws; always returns an {@link OnSyncResult}.
 */
export async function onSync(opts: OnSyncOptions): Promise<OnSyncResult> {
  const logLine = async (line: string): Promise<void> => {
    try {
      if (opts.log) await opts.log(line);
      else await appendLog(`ON-SYNC: ${line}`, { home: opts.home, timestamp: opts.timestamp });
    } catch {
      // logging must never block
    }
  };

  try {
    // ── Step 1: the runtime gate (fail-closed). ──
    const fetchSettings = opts.fetchSettings ?? fetchSyncSettings;
    const settings = await fetchSettings(opts);
    if (!settings.enabled) {
      await logLine("gate disabled → no-op");
      return { mode: "disabled", detail: "ideChatSync disabled for this user" };
    }

    // ── Step 2: capture the CURRENT session only. ──
    const capture = opts.captureImpl ?? defaultCapture;
    const transcript = await capture(opts);
    if (!transcript || transcript.messages.length === 0) {
      await logLine("nothing to sync (no current-session transcript)");
      return { mode: "nothing-to-sync", detail: "no capturable current-session transcript" };
    }

    // ── Step 3: sanitise (redact + size-cap). ──
    const { transcript: clean, truncated, droppedOldest, bytes } = sanitiseTranscript(transcript);
    await logLine(`captured ${clean.messages.length} msg(s), ${bytes}B${truncated ? ` (truncated, dropped ${droppedOldest} oldest)` : ""}`);

    if (opts.dryRun) {
      await logLine("dry-run: would upload (no network)");
      return { mode: "dry-run", detail: `would upload ${clean.messages.length} message(s)` };
    }

    // ── Step 4: upload (update-in-place via deterministic id). ──
    const upload = opts.uploadImpl ?? uploadTranscript;
    const result = await upload(clean, {
      home: opts.home,
      server: opts.server,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
      timestamp: opts.timestamp,
      status: opts.status,
    });
    await logLine(`upload ${result.ok ? "ok" : "failed"} (id=${result.externalChatId ?? "?"}${result.error ? `, ${result.error}` : ""})`);
    if (!result.ok && (result.error?.includes("not paired") ?? false)) {
      return { mode: "not-paired", upload: result, detail: result.error };
    }
    return { mode: "uploaded", upload: result };
  } catch (err) {
    await logLine(`unexpected error — treated as no-op: ${errMessage(err)}`);
    return { mode: "error", detail: errMessage(err) };
  }
}
