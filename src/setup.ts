// `gocode-sync setup` — installs the sync hook ALONGSIDE the notify hook.
//
// The companion does NOT replace the notify hook; it adds a SECOND end-of-turn
// hook entry that calls `gocode-sync on-sync …`. Both run on stop. We MERGE,
// never clobber: the user's own hooks and the existing `gocode-notify` hook are
// preserved; our entry is replaced-in-place on re-run (idempotent) and removed
// surgically on uninstall.
//
// Our entries are identified by the marker `gocode-sync` + the per-IDE source
// flag, so idempotency + uninstall survive command-string version bumps.
//
// Cursor → `~/.cursor/hooks.json`  (stop array)
// Claude → `~/.claude/settings.json` (hooks.Stop group array)
//
// Zero runtime deps — Node built-ins only.
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveHome, type PathOpts } from "./creds.js";

/** MCP server key + entry we register so an agent can sync on explicit request. */
export const MCP_SERVER_NAME = "gocode-sync";
export const MCP_SERVER_ENTRY = {
  command: "npx",
  args: ["-y", "@trygocode/sync", "mcp"],
} as const;

/** Cursor stop-hook command: pass the hook payload on stdin to on-sync. */
export const CURSOR_SYNC_COMMAND =
  "gocode-sync on-sync --source cursor --stdin || true";

/** Claude Stop-hook command: session id + transcript path come from env/stdin. */
export const CLAUDE_SYNC_COMMAND =
  'gocode-sync on-sync --source claude_code --session "$CLAUDE_SESSION_ID" --stdin || true';

/** Markers identifying OUR cursor entry (both must be present). */
const CURSOR_MARKERS = ["gocode-sync", "--source cursor"] as const;
/** Markers identifying OUR claude entry. */
const CLAUDE_MARKERS = ["gocode-sync", "--source claude_code"] as const;

export interface SetupResult {
  /** Absolute paths we wrote/removed. */
  paths: string[];
  /** Per-runtime detail lines. */
  detail: string[];
  failed?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`gocode-sync: ${file} contains invalid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`gocode-sync: ${file} is not a JSON object`);
  return parsed;
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

function cursorHooksPath(opts?: PathOpts): string {
  return path.join(resolveHome(opts), ".cursor", "hooks.json");
}
function claudeSettingsPath(opts?: PathOpts): string {
  return path.join(resolveHome(opts), ".claude", "settings.json");
}

function commandMatches(cmd: unknown, markers: readonly string[]): boolean {
  return typeof cmd === "string" && markers.every((m) => cmd.includes(m));
}

// ── Cursor: stop is a flat array of { command } ──
function isOurCursorHook(h: unknown): boolean {
  return isRecord(h) && commandMatches(h.command, CURSOR_MARKERS);
}

function mergeCursorStop(config: Record<string, unknown>): void {
  if (typeof config.version !== "number") config.version = 1;
  const hooks = isRecord(config.hooks) ? config.hooks : {};
  const existing = Array.isArray(hooks.stop) ? (hooks.stop as unknown[]) : [];
  const preserved = existing.filter((h) => !isOurCursorHook(h));
  preserved.push({ command: CURSOR_SYNC_COMMAND });
  hooks.stop = preserved;
  config.hooks = hooks;
}

// ── Claude: hooks.Stop is an array of groups { hooks: [{type,command}] } ──
function isOurClaudeCommand(h: unknown): boolean {
  return isRecord(h) && commandMatches(h.command, CLAUDE_MARKERS);
}

function stripOurClaudeGroups(groups: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      out.push(group);
      continue;
    }
    const kept = group.hooks.filter((h) => !isOurClaudeCommand(h));
    if (kept.length === 0) continue;
    out.push(kept.length === group.hooks.length ? group : { ...group, hooks: kept });
  }
  return out;
}

function mergeClaudeStop(settings: Record<string, unknown>): void {
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  const existing = Array.isArray(hooks.Stop) ? (hooks.Stop as unknown[]) : [];
  const preserved = stripOurClaudeGroups(existing);
  preserved.push({ hooks: [{ type: "command", command: CLAUDE_SYNC_COMMAND }] });
  hooks.Stop = preserved;
  settings.hooks = hooks;
}

/** Merge our MCP server entry into an `mcpServers` map. Mutates in place. */
function mergeMcp(config: Record<string, unknown>): void {
  const servers = isRecord(config.mcpServers) ? config.mcpServers : {};
  servers[MCP_SERVER_NAME] = { ...MCP_SERVER_ENTRY, args: [...MCP_SERVER_ENTRY.args] };
  config.mcpServers = servers;
}

/** Remove our MCP server entry from an `mcpServers` map. Returns true if changed. */
function stripMcp(config: Record<string, unknown>): boolean {
  if (isRecord(config.mcpServers) && MCP_SERVER_NAME in config.mcpServers) {
    delete config.mcpServers[MCP_SERVER_NAME];
    if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
    return true;
  }
  return false;
}

function cursorMcpPath(opts?: PathOpts): string {
  return path.join(resolveHome(opts), ".cursor", "mcp.json");
}

/**
 * Install the sync hook into whichever of Cursor/Claude are present. MERGE,
 * never clobber. Never throws — returns a {@link SetupResult}. Idempotent.
 */
export async function setupSync(opts?: PathOpts): Promise<SetupResult> {
  const paths: string[] = [];
  const detail: string[] = [];
  try {
    // Cursor (only if ~/.cursor exists or hooks.json is present — but we create
    // it if the user clearly uses Cursor; here we mirror notify and just write).
    const cursorPath = cursorHooksPath(opts);
    try {
      const cfg = (await readJsonObject(cursorPath)) ?? {};
      mergeCursorStop(cfg);
      await writeJsonFile(cursorPath, cfg);
      paths.push(cursorPath);
      detail.push("Cursor: merged sync stop hook");

      // Cursor MCP entry lives in a SEPARATE file (~/.cursor/mcp.json).
      const cursorMcp = cursorMcpPath(opts);
      const mcpCfg = (await readJsonObject(cursorMcp)) ?? {};
      mergeMcp(mcpCfg);
      await writeJsonFile(cursorMcp, mcpCfg);
      paths.push(cursorMcp);
      detail.push("Cursor: merged MCP server entry");
    } catch (err) {
      detail.push(`Cursor: skipped (${errMessage(err)})`);
    }

    // Claude — hooks + MCP entry both live in settings.json.
    const claudePath = claudeSettingsPath(opts);
    try {
      const settings = (await readJsonObject(claudePath)) ?? {};
      mergeClaudeStop(settings);
      mergeMcp(settings);
      await writeJsonFile(claudePath, settings);
      paths.push(claudePath);
      detail.push("Claude Code: merged sync Stop hook + MCP entry");
    } catch (err) {
      detail.push(`Claude Code: skipped (${errMessage(err)})`);
    }

    return { paths, detail };
  } catch (err) {
    return { paths, detail, failed: true };
  }
}

/** Remove EXACTLY our sync hook entries. Idempotent, never throws. */
export async function uninstallSync(opts?: PathOpts): Promise<SetupResult> {
  const paths: string[] = [];
  const detail: string[] = [];
  try {
    const cursorPath = cursorHooksPath(opts);
    const cfg = await readJsonObject(cursorPath).catch(() => null);
    if (cfg && isRecord(cfg.hooks) && Array.isArray((cfg.hooks as Record<string, unknown>).stop)) {
      const hooks = cfg.hooks as Record<string, unknown>;
      const before = (hooks.stop as unknown[]).length;
      const kept = (hooks.stop as unknown[]).filter((h) => !isOurCursorHook(h));
      if (kept.length !== before) {
        if (kept.length > 0) hooks.stop = kept;
        else delete hooks.stop;
        if (Object.keys(hooks).length === 0) delete cfg.hooks;
        await writeJsonFile(cursorPath, cfg);
        paths.push(cursorPath);
        detail.push("Cursor: removed sync stop hook");
      }
    }

    // Cursor MCP entry (separate file).
    const cursorMcp = cursorMcpPath(opts);
    const mcpCfg = await readJsonObject(cursorMcp).catch(() => null);
    if (mcpCfg && stripMcp(mcpCfg)) {
      await writeJsonFile(cursorMcp, mcpCfg);
      paths.push(cursorMcp);
      detail.push("Cursor: removed MCP server entry");
    }

    const claudePath = claudeSettingsPath(opts);
    const settings = await readJsonObject(claudePath).catch(() => null);
    if (settings) {
      let changed = false;
      if (isRecord(settings.hooks) && Array.isArray((settings.hooks as Record<string, unknown>).Stop)) {
        const hooks = settings.hooks as Record<string, unknown>;
        const kept = stripOurClaudeGroups(hooks.Stop as unknown[]);
        if (kept.length !== (hooks.Stop as unknown[]).length) {
          changed = true;
          if (kept.length > 0) hooks.Stop = kept;
          else delete hooks.Stop;
          if (Object.keys(hooks).length === 0) delete settings.hooks;
        }
      }
      if (stripMcp(settings)) changed = true;
      if (changed) {
        await writeJsonFile(claudePath, settings);
        paths.push(claudePath);
        detail.push("Claude Code: removed sync Stop hook + MCP entry");
      }
    }

    return { paths, detail };
  } catch (err) {
    return { paths, detail, failed: true };
  }
}
