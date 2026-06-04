import { test } from "node:test";
import assert from "node:assert/strict";
import { redactString, sanitiseTranscript } from "../src/redact.js";
import type { CapturedTranscript } from "../src/transcript.js";

test("redactString masks common token shapes", () => {
  assert.match(redactString("key sk-ABCDEFGHIJKLMNOPqrst here"), /«redacted»/);
  assert.match(redactString("ghp_ABCDEFGHIJKLMNOPQRSTuvwxyz0123"), /«redacted»/);
  assert.match(redactString("Authorization: Bearer abcdef0123456789ABCDEF"), /«redacted»/);
  assert.match(redactString('api_key="supersecretvalue123"'), /api_key="«redacted»"/);
  assert.match(redactString("gck_ABCDEFGHIJKLMNOP1234"), /«redacted»/);
});

test("redactString leaves ordinary prose untouched", () => {
  const prose = "This is a normal sentence about the weather and code.";
  assert.equal(redactString(prose), prose);
});

function tx(messages: { role: "user" | "assistant"; content: string }[]): CapturedTranscript {
  return {
    source: "cursor",
    ide_session_id: "s1",
    workspace_path: "/w",
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
}

test("sanitiseTranscript redacts content", () => {
  const res = sanitiseTranscript(tx([{ role: "user", content: "token ghp_ABCDEFGHIJKLMNOPQRSTuvwx0123" }]));
  assert.match(res.transcript.messages[0].content, /«redacted»/);
  assert.equal(res.truncated, false);
});

test("sanitiseTranscript drops oldest to fit the cap", () => {
  const big = "x".repeat(2000);
  const msgs = Array.from({ length: 50 }, (_, i) => ({ role: "user" as const, content: `${i}-${big}` }));
  const res = sanitiseTranscript(tx(msgs), 10 * 1024);
  assert.equal(res.truncated, true);
  assert.ok(res.droppedOldest > 0);
  assert.ok(res.bytes <= 10 * 1024);
  // The most-recent message must survive.
  assert.match(res.transcript.messages.at(-1)!.content, /^49-/);
});

test("sanitiseTranscript hard-truncates a single oversized message", () => {
  const huge = "y".repeat(50_000);
  const res = sanitiseTranscript(tx([{ role: "assistant", content: huge }]), 1024);
  assert.equal(res.transcript.messages.length, 1);
  assert.match(res.transcript.messages[0].content, /truncated to fit size cap/);
  assert.ok(res.bytes <= 1024 + 64); // small envelope slack
});
