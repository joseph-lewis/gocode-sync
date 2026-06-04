// End-to-end integration test for the OpenCode sync path that Sentinel flagged
// as uncovered: the REAL wiring from the installed plugin's shell-out through
// the CLI's stdin parsing, the onSync gate, captureOpenCode, sanitise, and the
// upload POST. We run the BUILT CLI binary (dist/src/cli.js) as a subprocess
// with the OpenCode plugin payload piped on stdin — exactly what the generated
// session.idle plugin does — pointed at a local mock GoCode server.
//
// This is the only test that exercises argv-parse -> readStdin -> JSON.parse ->
// source==="opencode" -> onSync -> fetch(gate) -> captureOpenCode -> upload.
// A regression in any of those seams (stdin parsing, source routing, option
// forwarding) would make the installed plugin silently upload nothing while the
// capture/setup unit tests still pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/test/e2e_opencode.test.js -> dist/src/cli.js
const CLI = path.resolve(__dirname, "..", "src", "cli.js");

interface MockServer {
  url: string;
  uploads: Array<{ auth?: string; body: any }>;
  gateEnabled: { value: boolean };
  close: () => Promise<void>;
}

/** A tiny local GoCode server that answers the gate + upload endpoints. */
async function startMockServer(): Promise<MockServer> {
  const uploads: Array<{ auth?: string; body: any }> = [];
  const gateEnabled = { value: true };

  const server = http.createServer((req, res) => {
    const { method, url } = req;
    if (method === "GET" && url === "/api/v1/ide-chats/settings") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ enabled: gateEnabled.value }));
      return;
    }
    if (method === "POST" && url === "/api/v1/ide-chats/upload") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        let body: any = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* record the raw failure below */
        }
        uploads.push({ auth: req.headers.authorization, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, external_chat_id: body?.external_chat_id }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    uploads,
    gateEnabled,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function tmpHomeWithCreds(server: string): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gcsync-e2e-"));
  await fs.mkdir(path.join(home, ".gocode"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".gocode", "credentials"),
    JSON.stringify({ api_key: "gck_e2e", server, user_id: "github:42", label: "e2e" }),
  );
  return home;
}

/** Run the built CLI with the given args + stdin, in a temp HOME. Exit code + output. */
function runCli(
  args: string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/** The payload our generated OpenCode session.idle plugin pipes on stdin. */
function opencodePayload(): string {
  return JSON.stringify({
    session_id: "ses_e2e_123",
    workspace_path: "/work/demo-repo",
    messages: [
      { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "add a feature" }] },
      {
        info: { id: "m2", role: "assistant" },
        parts: [
          { type: "reasoning", text: "PRIVATE THINKING" },
          { type: "tool", tool: "edit" },
          { type: "text", text: "done" },
        ],
      },
    ],
  });
}

test("e2e: OpenCode plugin payload on stdin → CLI → gate → capture → upload", async () => {
  const mock = await startMockServer();
  const home = await tmpHomeWithCreds(mock.url);
  try {
    const res = await runCli(
      ["on-sync", "--source", "opencode", "--stdin", "--verbose"],
      opencodePayload(),
      { ...process.env, HOME: home },
    );

    // The CLI must ALWAYS exit 0 (never block the agent turn).
    assert.equal(res.code, 0, `cli exited ${res.code}; stderr=${res.stderr}`);

    // Exactly one upload arrived at the mock server.
    assert.equal(mock.uploads.length, 1, "exactly one upload POST");
    const up = mock.uploads[0];
    assert.equal(up.auth, "Bearer gck_e2e", "bearer from shared credentials");
    assert.equal(up.body.source, "opencode");
    assert.equal(typeof up.body.external_chat_id, "string");
    assert.ok(up.body.external_chat_id.length > 0, "stable external_chat_id sent");

    // The conversation made it through with the right messages.
    const contents = (up.body.messages as Array<{ content: string }>).map((m) => m.content).join("\n");
    assert.match(contents, /add a feature/);
    assert.match(contents, /done/);
    assert.match(contents, /\[tool: edit\]/);
    // Privacy: reasoning parts must NEVER leave the machine.
    assert.doesNotMatch(contents, /PRIVATE THINKING/);
  } finally {
    await mock.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("e2e: stable external_chat_id is identical across two syncs of the same session (no duplicates)", async () => {
  const mock = await startMockServer();
  const home = await tmpHomeWithCreds(mock.url);
  try {
    const env = { ...process.env, HOME: home };
    await runCli(["on-sync", "--source", "opencode", "--stdin"], opencodePayload(), env);
    await runCli(["on-sync", "--source", "opencode", "--stdin"], opencodePayload(), env);

    assert.equal(mock.uploads.length, 2, "two upload attempts");
    const id1 = mock.uploads[0].body.external_chat_id;
    const id2 = mock.uploads[1].body.external_chat_id;
    assert.equal(id1, id2, "same session → same id (server upserts, never duplicates)");
  } finally {
    await mock.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("e2e: server gate OFF (fail-closed) → CLI uploads NOTHING", async () => {
  const mock = await startMockServer();
  mock.gateEnabled.value = false; // user has NOT opted in
  const home = await tmpHomeWithCreds(mock.url);
  try {
    const res = await runCli(
      ["on-sync", "--source", "opencode", "--stdin", "--verbose"],
      opencodePayload(),
      { ...process.env, HOME: home },
    );
    assert.equal(res.code, 0);
    assert.equal(mock.uploads.length, 0, "no upload when the gate is disabled");
  } finally {
    await mock.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("e2e: malformed stdin JSON is a safe no-op (exit 0, no upload)", async () => {
  const mock = await startMockServer();
  const home = await tmpHomeWithCreds(mock.url);
  try {
    const res = await runCli(
      ["on-sync", "--source", "opencode", "--stdin"],
      "{ this is not valid json ",
      { ...process.env, HOME: home },
    );
    assert.equal(res.code, 0, "never blocks the turn even on bad input");
    assert.equal(mock.uploads.length, 0, "nothing uploaded for an unparseable payload");
  } finally {
    await mock.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});
