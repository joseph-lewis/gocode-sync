import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupSync, uninstallSync, CURSOR_SYNC_COMMAND, CLAUDE_SYNC_COMMAND } from "../src/setup.js";

async function tmpHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "gcsync-setup-"));
}

async function readJson(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

test("setupSync merges cursor + claude hooks, preserving user entries", async () => {
  const home = await tmpHome();
  // Pre-existing user config with the notify hook already present.
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".cursor", "hooks.json"),
    JSON.stringify({ version: 1, hooks: { stop: [{ command: "gocode-notify on-stop --source cursor || true" }] } }),
  );
  await fs.mkdir(path.join(home, ".claude"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "gocode-notify on-stop --source claude_code || true" }] }] } }),
  );

  await setupSync({ home });

  const cursor = await readJson(path.join(home, ".cursor", "hooks.json"));
  const cursorCmds = cursor.hooks.stop.map((h: any) => h.command);
  assert.ok(cursorCmds.some((c: string) => c.includes("gocode-notify")), "notify hook preserved");
  assert.ok(cursorCmds.includes(CURSOR_SYNC_COMMAND), "sync hook added");
  assert.equal(cursor.hooks.stop.length, 2);

  const claude = await readJson(path.join(home, ".claude", "settings.json"));
  const claudeCmds = claude.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
  assert.ok(claudeCmds.some((c: string) => c.includes("gocode-notify")), "notify Stop preserved");
  assert.ok(claudeCmds.includes(CLAUDE_SYNC_COMMAND), "sync Stop added");

  // MCP entries land too: Cursor in mcp.json, Claude in settings.json.
  const cursorMcp = await readJson(path.join(home, ".cursor", "mcp.json"));
  assert.ok(cursorMcp.mcpServers?.["gocode-sync"], "cursor MCP entry added");
  assert.ok(claude.mcpServers?.["gocode-sync"], "claude MCP entry added");
});

test("setupSync is idempotent (no duplicate sync entries)", async () => {
  const home = await tmpHome();
  await setupSync({ home });
  await setupSync({ home });
  const cursor = await readJson(path.join(home, ".cursor", "hooks.json"));
  const ours = cursor.hooks.stop.filter((h: any) => h.command === CURSOR_SYNC_COMMAND);
  assert.equal(ours.length, 1, "exactly one sync hook after two setups");
});

test("uninstallSync removes ONLY our entries", async () => {
  const home = await tmpHome();
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".cursor", "hooks.json"),
    JSON.stringify({ version: 1, hooks: { stop: [{ command: "gocode-notify on-stop --source cursor || true" }] } }),
  );
  await setupSync({ home });
  await uninstallSync({ home });
  const cursor = await readJson(path.join(home, ".cursor", "hooks.json"));
  const cmds = cursor.hooks.stop.map((h: any) => h.command);
  assert.ok(cmds.some((c: string) => c.includes("gocode-notify")), "notify hook still there");
  assert.ok(!cmds.includes(CURSOR_SYNC_COMMAND), "sync hook removed");
});
