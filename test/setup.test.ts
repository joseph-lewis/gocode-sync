import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  setupSync,
  uninstallSync,
  CURSOR_SYNC_COMMAND,
  CLAUDE_SYNC_COMMAND,
  OPENCODE_SYNC_COMMAND,
} from "../src/setup.js";

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

test("setupSync skips OpenCode entirely when no opencode config dir exists", async () => {
  const home = await tmpHome();
  const res = await setupSync({ home });
  assert.ok(
    res.detail.some((d) => /OpenCode: skipped/.test(d)),
    "OpenCode skipped with no config dir",
  );
  // We must NOT have created ~/.config/opencode for a non-OpenCode user.
  const exists = await fs
    .stat(path.join(home, ".config", "opencode"))
    .then(() => true)
    .catch(() => false);
  assert.equal(exists, false, "no opencode dir created");
});

test("setupSync writes the OpenCode session.idle plugin + mcp entry when dir exists", async () => {
  const home = await tmpHome();
  await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true });

  await setupSync({ home });

  const pluginFile = path.join(home, ".config", "opencode", "plugin", "gocode-sync.js");
  const plugin = await fs.readFile(pluginFile, "utf8");
  // Subscribes to session.idle and shells out to our opencode source command.
  assert.match(plugin, /session\.idle/);
  assert.ok(plugin.includes(OPENCODE_SYNC_COMMAND), "plugin shells out to the sync command");
  assert.match(plugin, /client\.session\.messages/);
  assert.match(plugin, /--source opencode/);

  // MCP entry lands in opencode.json in OpenCode's distinct shape.
  const cfg = await readJson(path.join(home, ".config", "opencode", "opencode.json"));
  assert.equal(cfg.mcp?.["gocode-sync"]?.type, "local");
  assert.deepEqual(cfg.mcp["gocode-sync"].command, ["npx", "-y", "@trygocode/sync", "mcp"]);
  assert.equal(cfg.mcp["gocode-sync"].enabled, true);
});

test("OpenCode setup is idempotent + uninstall is surgical (preserves user mcp + plugins)", async () => {
  const home = await tmpHome();
  const ocDir = path.join(home, ".config", "opencode");
  await fs.mkdir(path.join(ocDir, "plugin"), { recursive: true });
  // Pre-existing user config: their own mcp server + their own plugin file.
  await fs.writeFile(
    path.join(ocDir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { mine: { type: "local", command: ["x"], enabled: true } } }),
  );
  await fs.writeFile(path.join(ocDir, "plugin", "user-plugin.js"), "export const Mine = async () => ({});\n");

  await setupSync({ home });
  await setupSync({ home }); // idempotent

  let cfg = await readJson(path.join(ocDir, "opencode.json"));
  assert.equal(cfg.$schema, "https://opencode.ai/config.json", "unrelated key preserved");
  assert.ok(cfg.mcp.mine, "user's mcp server preserved");
  assert.ok(cfg.mcp["gocode-sync"], "our mcp server present");

  await uninstallSync({ home });

  cfg = await readJson(path.join(ocDir, "opencode.json"));
  assert.ok(cfg.mcp.mine, "user's mcp server still there after uninstall");
  assert.ok(!cfg.mcp["gocode-sync"], "our mcp entry removed");
  // Our plugin removed; the user's plugin untouched.
  const ourGone = await fs
    .stat(path.join(ocDir, "plugin", "gocode-sync.js"))
    .then(() => false)
    .catch(() => true);
  assert.ok(ourGone, "our plugin file removed");
  const userKept = await fs
    .stat(path.join(ocDir, "plugin", "user-plugin.js"))
    .then(() => true)
    .catch(() => false);
  assert.ok(userKept, "user's plugin file preserved");
});

test("uninstallSync never deletes a same-named plugin file that isn't ours", async () => {
  const home = await tmpHome();
  const ocDir = path.join(home, ".config", "opencode");
  await fs.mkdir(path.join(ocDir, "plugin"), { recursive: true });
  // A user file that happens to share our name but lacks our markers.
  const decoy = path.join(ocDir, "plugin", "gocode-sync.js");
  await fs.writeFile(decoy, "export const NotOurs = async () => ({});\n");

  await uninstallSync({ home });

  const kept = await fs
    .stat(decoy)
    .then(() => true)
    .catch(() => false);
  assert.ok(kept, "non-ours plugin of the same name is NOT deleted");
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
