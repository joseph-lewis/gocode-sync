// Size-cap + best-effort secret redaction (PRD "Hard safety constraints" §6).
//
// Before ANY transcript leaves the machine we (a) run a best-effort redaction
// pass over each message's content to mask obvious secrets, and (b) cap the
// total payload size so a runaway transcript can never balloon the upload. Both
// are conservative: redaction never changes message structure, and the cap
// truncates oldest-first while always keeping the most recent messages (the
// part the user actually wants to read on their phone).
//
// This is best-effort, NOT a security guarantee — the README is explicit that
// transcripts may contain code/secrets and that this is why the feature is
// off-by-default + opt-in. Redaction reduces accidental leakage; it does not
// promise to catch everything.
//
// Zero runtime deps — Node built-ins only.
import type { CapturedTranscript, TranscriptMessage } from "./transcript.js";

/** Default max serialized payload size (bytes) before truncation kicks in. */
export const DEFAULT_MAX_BYTES = 512 * 1024; // 512 KiB

/** Placeholder substituted for a matched secret. */
const MASK = "«redacted»";

/**
 * Patterns we mask. Conservative on purpose — each targets a high-confidence
 * secret shape so we don't shred ordinary prose/code. Order matters only for
 * readability; all are applied.
 */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // Common API-key / token prefixes followed by a long token body.
  /\b(sk-[A-Za-z0-9]{16,})\b/g, // OpenAI-style
  /\b(gsk_[A-Za-z0-9]{16,})\b/g,
  /\b(ghp_[A-Za-z0-9]{20,})\b/g, // GitHub PAT
  /\b(gho_[A-Za-z0-9]{20,})\b/g, // GitHub OAuth
  /\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, // Slack
  /\b(AKIA[0-9A-Z]{16})\b/g, // AWS access key id
  /\b(gck_[A-Za-z0-9]{16,})\b/g, // GoCode api-key shape — never echo our own
  // `Authorization: Bearer <token>` headers.
  /\b(Bearer\s+[A-Za-z0-9._\-]{16,})/gi,
  // `key="..."` / `token: ...` style assignments with a long-ish value.
  /\b((?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*)(["']?)([^\s"']{8,})\2/gi,
];

/** Redact secrets in a single string. Never throws; returns the masked copy. */
export function redactString(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_match, p1, p2, p3) => {
      // For the key=value pattern (3 groups) keep the `key=` prefix + quote.
      if (typeof p3 === "string") return `${p1}${p2}${MASK}${p2}`;
      // For the simple-token patterns, mask the whole match.
      return MASK;
    });
  }
  return out;
}

/** Apply redaction to every message's content. Returns a new array. */
function redactMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  return messages.map((m) => ({ ...m, content: redactString(m.content) }));
}

/** Byte length of a string under UTF-8. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Result of {@link sanitiseTranscript}: cleaned transcript + what we did. */
export interface SanitiseResult {
  transcript: CapturedTranscript;
  /** True when the size cap forced us to drop the oldest message(s). */
  truncated: boolean;
  /** How many oldest messages were dropped to fit the cap. */
  droppedOldest: number;
  /** Approx serialized size of the messages we kept (bytes). */
  bytes: number;
}

/**
 * Redact secrets, then cap total size by dropping OLDEST messages until the
 * serialized `messages` array fits `maxBytes`. We always keep at least the most
 * recent message even if it alone exceeds the cap (we then hard-truncate that
 * single message's content). Never mutates the input.
 */
export function sanitiseTranscript(
  input: CapturedTranscript,
  maxBytes: number = DEFAULT_MAX_BYTES,
): SanitiseResult {
  const redacted = redactMessages(input.messages);

  // Drop oldest until the kept tail fits. Iterate from the end (newest) back.
  let kept: TranscriptMessage[] = [...redacted];
  let droppedOldest = 0;
  const sizeOf = (msgs: TranscriptMessage[]): number => byteLen(JSON.stringify(msgs));

  while (kept.length > 1 && sizeOf(kept) > maxBytes) {
    kept = kept.slice(1); // drop the oldest
    droppedOldest += 1;
  }

  // Edge: a single remaining message still over cap → hard-truncate its content.
  if (kept.length === 1 && sizeOf(kept) > maxBytes) {
    const only = kept[0];
    // Reserve some room for the JSON envelope + marker.
    const marker = "\n\n…[truncated to fit size cap]";
    const budget = Math.max(0, maxBytes - byteLen(JSON.stringify({ ...only, content: "" })) - byteLen(marker));
    kept = [{ ...only, content: only.content.slice(0, budget) + marker }];
  }

  return {
    transcript: { ...input, messages: kept },
    truncated: droppedOldest > 0 || kept.length !== redacted.length,
    droppedOldest,
    bytes: sizeOf(kept),
  };
}
