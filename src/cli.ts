#!/usr/bin/env node
// @trygocode/sync CLI — the optional IDE-chat-sync companion to @trygocode/notify.
//
// Commands:
//   setup                 Install the sync hook alongside your notify hook.
//   uninstall             Remove the sync hook (leaves notify untouched).
//   on-sync --source X    End-of-turn capture+upload of the CURRENT session
//                         (called automatically by the installed hook).
//   status                Show pairing + whether sync is enabled server-side.
//
// SAFETY: on-sync captures ONLY the current IDE session, is fail-CLOSED on the
// server gate, redacts secrets, caps size, and NEVER throws (always exit 0) so
// it can never block your agent's turn. See README for the full security model.
//
// Zero runtime deps — Node built-ins only.
import { readCredentials, resolveServerUrl } from "./creds.js";
import { setupSync, uninstallSync } from "./setup.js";
import { onSync } from "./sync.js";
import { fetchSyncSettings } from "./sync.js";
import { serveStdio } from "./mcp.js";
import type { SyncSource } from "./transcript.js";
import type { CursorHookPayload } from "./capture/cursor.js";
import type { OpenCodeHookPayload } from "./capture/opencode.js";

/** Read all of stdin (used to pass the IDE hook payload to on-sync). */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Minimal flag parser: `--key value` and `--flag` (boolean). */
function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function asString(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

async function cmdSetup(): Promise<number> {
  const res = await setupSync();
  for (const line of res.detail) console.log(line);
  if (res.failed) {
    console.error("Setup encountered errors.");
    return 1;
  }
  console.log("\nIDE chat sync hook installed. It only uploads when you enable");
  console.log("'Sync my IDE chat' in the GoCode app (off by default).");
  return 0;
}

async function cmdUninstall(): Promise<number> {
  const res = await uninstallSync();
  for (const line of res.detail) console.log(line);
  if (res.detail.length === 0) console.log("No gocode-sync hooks found.");
  return res.failed ? 1 : 0;
}

async function cmdStatus(): Promise<number> {
  const creds = await readCredentials().catch(() => null);
  if (!creds) {
    console.log("Not paired. Run `gocode-notify login` first (sync shares its pairing).");
    return 0;
  }
  console.log(`Paired as ${creds.user_id} (${creds.label})`);
  console.log(`Server: ${creds.server}`);
  const settings = await fetchSyncSettings({ source: "cursor" });
  console.log(`IDE chat sync: ${settings.enabled ? "ENABLED" : "disabled (default)"}`);
  return 0;
}

async function cmdOnSync(flags: Record<string, string | boolean>): Promise<number> {
  const source = asString(flags.source) as SyncSource | undefined;
  if (!source) {
    console.error("on-sync requires --source cursor|claude_code|opencode");
    return 0; // never block the turn
  }
  const server = await resolveServerUrl(asString(flags.server));

  let cursor: CursorHookPayload | undefined;
  let opencode: OpenCodeHookPayload | undefined;
  let claudeSession: string | undefined;
  let transcriptPath: string | undefined;

  if (flags.stdin) {
    const raw = await readStdin();
    if (raw.trim()) {
      try {
        const payload = JSON.parse(raw) as Record<string, unknown>;
        if (source === "cursor") cursor = payload as CursorHookPayload;
        if (source === "opencode") opencode = payload as OpenCodeHookPayload;
        if (source === "claude_code") {
          if (typeof payload.session_id === "string") claudeSession = payload.session_id;
          if (typeof payload.transcript_path === "string") transcriptPath = payload.transcript_path;
        }
      } catch {
        // unparseable stdin → fall through to flag/env inputs
      }
    }
  }
  // Explicit --session flag (or env) wins for Claude.
  claudeSession = asString(flags.session) ?? claudeSession ?? process.env.CLAUDE_SESSION_ID;

  const res = await onSync({
    source,
    server,
    dryRun: flags["dry-run"] === true,
    cursor,
    opencode,
    claude: source === "claude_code" && claudeSession ? { sessionId: claudeSession, transcriptPath } : undefined,
  });
  // Quiet by default; print only on dry-run / verbose for debuggability.
  if (flags["dry-run"] || flags.verbose) console.log(`[gocode-sync] ${res.mode}${res.detail ? `: ${res.detail}` : ""}`);
  return 0; // ALWAYS exit 0 — never block the agent's turn
}

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;
  const flags = parseFlags(rest);
  switch (cmd) {
    case "setup":
      return cmdSetup();
    case "uninstall":
      return cmdUninstall();
    case "status":
      return cmdStatus();
    case "on-sync":
      return cmdOnSync(flags);
    case "mcp":
      // Long-lived stdio MCP server — resolves only when the client
      // disconnects. Exposes the explicit-request sync tool + status.
      await serveStdio({ serverFlag: asString(flags.server) });
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log("gocode-sync — optional IDE chat sync companion for @trygocode/notify");
      console.log("\nUsage:");
      console.log("  gocode-sync setup        Install sync hook alongside notify");
      console.log("  gocode-sync uninstall    Remove the sync hook");
      console.log("  gocode-sync status       Show pairing + sync-enabled state");
      console.log("  gocode-sync on-sync ...  (called by the hook; current session only)");
      console.log("  gocode-sync mcp          Run the MCP server (explicit-request sync tool)");
      console.log("\nSyncs ONLY your current IDE chat, only when enabled in the GoCode app.");
      return 0;
    default:
      console.error(`Unknown command: ${cmd}`);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    // Defence in depth: the CLI must never crash a hook. Log + exit 0 for the
    // hook-invoked path; non-zero only for interactive misuse is acceptable but
    // we choose 0 to honour "never block the turn".
    console.error(`[gocode-sync] unexpected: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 0;
  });
