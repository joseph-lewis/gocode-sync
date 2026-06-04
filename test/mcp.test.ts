import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TOOLS,
  SYNC_TOOL,
  STATUS_TOOL,
  handleSync,
  handleStatus,
  createMcpServer,
} from "../src/mcp.js";

async function tmpHomeWithCreds(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gcsync-mcp-"));
  await fs.mkdir(path.join(home, ".gocode"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".gocode", "credentials"),
    JSON.stringify({ api_key: "gck_test", server: "https://example.test", user_id: "github:1", label: "t" }),
  );
  return home;
}

test("exposes exactly two tools with stable names", () => {
  assert.equal(TOOLS.length, 2);
  const names = TOOLS.map((t) => t.name);
  assert.ok(names.includes(SYNC_TOOL));
  assert.ok(names.includes(STATUS_TOOL));
});

test("createMcpServer builds without touching the network", () => {
  const server = createMcpServer();
  assert.ok(server);
});

test("handleSync refuses Cursor (no in-process session for MCP)", async () => {
  const res = await handleSync({ source: "cursor" });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /Cursor chats sync automatically/);
});

test("handleSync errors clearly when no Claude session is set", async () => {
  const prev = process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  try {
    const res = await handleSync({ source: "claude_code" });
    assert.equal(res.isError, true);
    assert.match((res.content[0] as { text: string }).text, /CLAUDE_SESSION_ID not set/);
  } finally {
    if (prev !== undefined) process.env.CLAUDE_SESSION_ID = prev;
  }
});

test("handleStatus reports not-paired when no credentials", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gcsync-mcp-np-"));
  const res = await handleStatus({ home });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /NOT paired/);
});

test("handleStatus reports disabled gate when paired but sync off", async () => {
  const home = await tmpHomeWithCreds();
  const fakeFetch = (async () => new Response(JSON.stringify({ enabled: false }), { status: 200 })) as unknown as typeof fetch;
  const res = await handleStatus({ home, fetchImpl: fakeFetch });
  assert.equal(res.isError, true); // disabled → isError so the agent surfaces it
  assert.match((res.content[0] as { text: string }).text, /disabled/);
});

test("handleStatus is OK when paired AND enabled", async () => {
  const home = await tmpHomeWithCreds();
  const fakeFetch = (async () => new Response(JSON.stringify({ enabled: true }), { status: 200 })) as unknown as typeof fetch;
  const res = await handleStatus({ home, fetchImpl: fakeFetch });
  assert.notEqual(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /ENABLED/);
});
