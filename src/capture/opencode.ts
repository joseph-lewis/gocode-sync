// OpenCode capture adapter — STUB (PRD "Per-IDE capture adapters": OpenCode is
// marked TBD; its config writer in @trygocode/notify is still a stub, so chat
// sync for OpenCode lands after that is real).
//
// We ship an explicit, honest stub rather than a brittle best-effort reader of
// an unverified store: returning null + a clear reason keeps the fail-safe
// contract (never throw, never guess, never read the wrong thing).
import type { CapturedTranscript } from "../transcript.js";

/** Stable reason string callers can log / surface for OpenCode. */
export const OPENCODE_UNSUPPORTED_REASON =
  "OpenCode chat sync is not yet supported — only Cursor and Claude Code are " +
  "captured today. Track @trygocode/sync for OpenCode support.";

/** Always returns null: OpenCode capture is not implemented yet. */
export function captureOpenCode(): CapturedTranscript | null {
  return null;
}
