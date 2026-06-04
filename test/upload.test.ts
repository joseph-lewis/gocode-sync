import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { uploadTranscript } from "../src/upload.js";
import type { CapturedTranscript } from "../src/transcript.js";

async function tmpHomeWithCreds(server = "https://example.test"): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gcsync-up-"));
  await fs.mkdir(path.join(home, ".gocode"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".gocode", "credentials"),
    JSON.stringify({ api_key: "gck_test", server, user_id: "github:1", label: "test" }),
  );
  return home;
}

const tx: CapturedTranscript = {
  source: "claude_code",
  ide_session_id: "sess",
  workspace_path: "/work/repo",
  project: "owner/repo",
  title: "T",
  messages: [{ role: "user", content: "hi" }],
};

test("uploadTranscript posts to /ide-chats/upload with bearer + stable id", async () => {
  const home = await tmpHomeWithCreds();
  let captured: { url?: string; body?: any; auth?: string } = {};
  const fakeFetch = (async (url: any, init: any) => {
    captured.url = String(url);
    captured.auth = init.headers.authorization;
    captured.body = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const res = await uploadTranscript(tx, { home, fetchImpl: fakeFetch });
  assert.ok(res.ok);
  assert.match(captured.url!, /\/api\/v1\/ide-chats\/upload$/);
  assert.equal(captured.auth, "Bearer gck_test");
  assert.match(captured.body.external_chat_id, /^[0-9a-f]{32}$/);
  assert.equal(captured.body.source, "claude_code");
  assert.equal(captured.body.status, "finished");
  assert.equal(captured.body.messages.length, 1);
});

test("uploadTranscript never throws on network error", async () => {
  const home = await tmpHomeWithCreds();
  const fakeFetch = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  const res = await uploadTranscript(tx, { home, fetchImpl: fakeFetch });
  assert.equal(res.ok, false);
  assert.match(res.error!, /request failed/);
});

test("uploadTranscript reports not-paired when no credentials", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gcsync-nopair-"));
  const res = await uploadTranscript(tx, { home });
  assert.equal(res.ok, false);
  assert.match(res.error!, /not paired/);
});

test("uploadTranscript surfaces non-2xx status", async () => {
  const home = await tmpHomeWithCreds();
  const fakeFetch = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
  const res = await uploadTranscript(tx, { home, fetchImpl: fakeFetch });
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
});
