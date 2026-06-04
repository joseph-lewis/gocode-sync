import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureClaude, encodeProjectDir, claudeSessionFile } from "../src/capture/claude.js";
import { captureCursor } from "../src/capture/cursor.js";
import { captureOpenCode, OPENCODE_UNSUPPORTED_REASON } from "../src/capture/opencode.js";

async function tmpHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "gcsync-"));
}

test("encodeProjectDir replaces / and . with -", () => {
  assert.equal(encodeProjectDir("/Users/me/proj.v2"), "-Users-me-proj-v2");
});

test("claudeSessionFile prefers explicit transcriptPath", () => {
  const p = claudeSessionFile({ sessionId: "s", cwd: "/c", transcriptPath: "/explicit/path.jsonl" });
  assert.equal(p, "/explicit/path.jsonl");
});

test("captureClaude reads ONLY the current session file", async () => {
  const home = await tmpHome();
  const cwd = "/work/proj";
  const dir = path.join(home, ".claude", "projects", encodeProjectDir(cwd));
  await fs.mkdir(dir, { recursive: true });
  // current session
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "Hello world" }, timestamp: "2026-01-01T00:00:00Z" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hi back" }] } }),
    JSON.stringify({ type: "system", message: { role: "system", content: "ignore me" } }),
  ].join("\n");
  await fs.writeFile(path.join(dir, "sess-1.jsonl"), lines);
  // a DIFFERENT session that must NOT be read
  await fs.writeFile(path.join(dir, "sess-2.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "OTHER CHAT" } }));

  const res = await captureClaude({ sessionId: "sess-1", cwd }, { home });
  assert.ok(res);
  assert.equal(res!.source, "claude_code");
  assert.equal(res!.ide_session_id, "sess-1");
  assert.equal(res!.messages.length, 2); // system skipped
  assert.equal(res!.messages[0].content, "Hello world");
  assert.equal(res!.messages[1].content, "Hi back");
  assert.equal(res!.title, "Hello world");
  // No message from the other chat leaked in.
  assert.ok(!res!.messages.some((m) => m.content.includes("OTHER CHAT")));
});

test("captureClaude returns null when the session file is missing", async () => {
  const home = await tmpHome();
  const res = await captureClaude({ sessionId: "nope", cwd: "/x" }, { home });
  assert.equal(res, null);
});

test("captureCursor reads from the hook payload, needs a stable id + messages", () => {
  const ok = captureCursor({
    conversation_id: "conv-9",
    workspace_path: "/work/repo",
    title: "My chat",
    messages: [
      { role: "user", content: "do a thing" },
      { role: "assistant", content: [{ text: "done" }] },
    ],
  });
  assert.ok(ok);
  assert.equal(ok!.source, "cursor");
  assert.equal(ok!.ide_session_id, "conv-9");
  assert.equal(ok!.messages.length, 2);
  assert.equal(ok!.title, "My chat");

  // No id → cannot key a stable chat → null (fail-safe).
  assert.equal(captureCursor({ messages: [{ role: "user", content: "x" }] }), null);
  // No messages → null.
  assert.equal(captureCursor({ conversation_id: "c" }), null);
});

test("captureOpenCode is a clear stub", () => {
  assert.equal(captureOpenCode(), null);
  assert.match(OPENCODE_UNSUPPORTED_REASON, /not yet supported/i);
});
