// Transcript upload client — POSTs ONE captured session to the server's
// per-user-isolated `/api/v1/ide-chats/upload` endpoint (PRD "Server endpoint").
//
// Contract (mirrors @trygocode/notify's send.ts "never block the agent"):
//   - Hard timeout (default 5s) via AbortController.
//   - NEVER throws and NEVER rejects — always resolves to an {@link UploadResult}.
//     A failed/blocked upload must never fail a hook's turn.
//   - Failures are appended to `~/.gocode/sync.log` (size-capped + rotated).
//   - Auth uses the SHARED api-key from `~/.gocode/credentials` (Bearer).
//
// Zero runtime deps — Node built-ins only.
import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_SERVER, gocodeDir, readCredentials, type PathOpts } from "./creds.js";
import { deriveExternalChatId, type CapturedTranscript } from "./transcript.js";

/** Status reported alongside the transcript (mirrors notify kinds loosely). */
export type SyncStatus = "finished" | "error" | "awaiting_input" | "halted";

/** Default request timeout (5s hard cap, matching notify). */
export const DEFAULT_TIMEOUT_MS = 5000;

/** Rotate `sync.log` once it grows past this (keeps one `.1` backup). */
export const MAX_LOG_BYTES = 256 * 1024;

/** The JSON body posted to `/api/v1/ide-chats/upload`. */
export interface UploadBody {
  external_chat_id: string;
  source: string;
  ide_session_id: string;
  workspace_path: string;
  project?: string;
  title?: string;
  status: SyncStatus;
  messages: CapturedTranscript["messages"];
}

/** Outcome of an upload attempt. `ok` is true only on a 2xx response. */
export interface UploadResult {
  ok: boolean;
  status?: number;
  /** The stable id we uploaded under (useful for deep-link/log correlation). */
  externalChatId?: string;
  error?: string;
}

export interface UploadOptions extends PathOpts {
  /** Explicit already-resolved server URL. Falls back to creds.server. */
  server?: string;
  /** Injectable fetch (defaults to global) so tests stub the network. */
  fetchImpl?: typeof fetch;
  /** Timeout override in ms. */
  timeoutMs?: number;
  /** Timestamp source for log lines. */
  timestamp?: () => string;
  /** Status to report (default "finished"). */
  status?: SyncStatus;
}

/** Absolute path to the sync failure log. */
export function syncLogPath(opts?: PathOpts): string {
  return path.join(gocodeDir(opts), "sync.log");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeServer(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Best-effort append to `~/.gocode/sync.log`; any error here is swallowed. */
export async function appendLog(line: string, opts?: UploadOptions): Promise<void> {
  try {
    await fs.mkdir(gocodeDir(opts), { recursive: true, mode: 0o700 });
    const file = syncLogPath(opts);
    try {
      const st = await fs.stat(file);
      if (st.size > MAX_LOG_BYTES) await fs.rename(file, `${file}.1`).catch(() => {});
    } catch {
      // no existing log → nothing to rotate
    }
    const ts = opts?.timestamp ? opts.timestamp() : new Date().toISOString();
    await fs.appendFile(file, `${ts} ${line}\n`);
  } catch {
    // intentionally silent
  }
}

async function failure(reason: string, opts: UploadOptions, extra: Partial<UploadResult> = {}): Promise<UploadResult> {
  await appendLog(`UPLOAD FAIL: ${reason}`, opts);
  return { ok: false, error: reason, ...extra };
}

/**
 * Upload one captured transcript. Resolves (never rejects) to an
 * {@link UploadResult}; callers may treat ANY result as "exit 0".
 *
 * The `external_chat_id` is derived deterministically from the transcript so
 * re-uploading the same session UPDATES the server record in place.
 */
export async function uploadTranscript(
  transcript: CapturedTranscript,
  opts: UploadOptions = {},
): Promise<UploadResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const status: SyncStatus = opts.status ?? "finished";

  let creds;
  try {
    creds = await readCredentials(opts);
  } catch (err) {
    return failure(`credentials unreadable: ${errMessage(err)}`, opts);
  }
  if (!creds) {
    return failure("not paired — run `gocode-notify login` first", opts);
  }

  const externalChatId = deriveExternalChatId({
    source: transcript.source,
    workspace_path: transcript.workspace_path,
    ide_session_id: transcript.ide_session_id,
  });

  const body: UploadBody = {
    external_chat_id: externalChatId,
    source: transcript.source,
    ide_session_id: transcript.ide_session_id,
    workspace_path: transcript.workspace_path,
    status,
    messages: transcript.messages,
  };
  if (transcript.project) body.project = transcript.project;
  if (transcript.title) body.title = transcript.title;

  const server = normalizeServer(opts.server ?? creds.server ?? DEFAULT_SERVER);
  const url = `${server}/api/v1/ide-chats/upload`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${creds.api_key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      return failure(`server responded ${res.status}`, opts, { status: res.status, externalChatId });
    }
    return { ok: true, status: res.status, externalChatId };
  } catch (err) {
    const reason = controller.signal.aborted
      ? `timeout after ${timeoutMs}ms`
      : `request failed: ${errMessage(err)}`;
    return failure(reason, opts, { externalChatId });
  } finally {
    clearTimeout(timer);
  }
}
