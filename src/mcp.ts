// gocode-sync MCP server mode (`gocode-sync mcp`).
//
// A minimal stdio MCP server exposing EXACTLY two tools (keep it tiny):
//   - gocode_sync_current_chat  → on EXPLICIT user request, sync the CURRENT
//                                 IDE chat now (does NOT bypass the server gate
//                                 or the current-session-only rule).
//   - gocode_sync_status        → pairing + sync-enabled self-diagnosis.
//
// IMPORTANT — this tool is NOT how routine syncing happens. Routine end-of-turn
// syncing is owned by the installed stop hook (`gocode-sync on-sync`). This MCP
// tool exists only so an agent can honour an explicit "sync this chat now"
// request. It funnels through the SAME gated, current-session-only, redacted
// `onSync` path as the hook — so it can never sync a different chat, and it
// uploads nothing when the user has not opted in (fail-closed).
//
// Capture context: for Claude Code we read `$CLAUDE_SESSION_ID` from the env
// (set in the agent's process). For Cursor there is no in-process session id
// available to an MCP tool, so the tool reports that the hook path is the
// supported route for Cursor.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "./version.js";
import { readCredentials, resolveServerUrl, type PathOpts } from "./creds.js";
import { onSync, fetchSyncSettings } from "./sync.js";
import type { SyncSource } from "./transcript.js";

/** Server identity advertised in the MCP `initialize` handshake. */
export const SERVER_NAME = "gocode-sync";

/** Tool an agent calls to sync the current chat on EXPLICIT user request. */
export const SYNC_TOOL = "gocode_sync_current_chat";
/** Tool an agent calls to self-diagnose pairing + sync-enabled state. */
export const STATUS_TOOL = "gocode_sync_status";

export const TOOLS: readonly Tool[] = [
  {
    name: SYNC_TOOL,
    description:
      "Sync ONLY the user's CURRENT IDE chat to their GoCode app, NOW. Call " +
      "this ONLY when the user EXPLICITLY asks to sync/push this chat to their " +
      "phone. Routine syncing is automatic via the installed hook — do NOT call " +
      "this otherwise. It uploads nothing unless the user has turned on 'Sync " +
      "my IDE chat' in the app (off by default), and it only ever captures the " +
      "current session — never other chats.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["cursor", "claude_code", "opencode"],
          description: "Which IDE this chat is in. Defaults to claude_code.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: STATUS_TOOL,
    description:
      "Report whether GoCode credentials are present and whether 'Sync my IDE " +
      "chat' is enabled server-side. Use this to self-diagnose: if NOT paired, " +
      "tell the user to run `gocode-notify login`; if sync is disabled, tell " +
      "them to enable it in the GoCode app.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export interface McpDeps extends PathOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  serverFlag?: string;
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Handle the explicit-request sync tool. Funnels through the gated onSync. */
export async function handleSync(
  args: Record<string, unknown> | undefined,
  deps: McpDeps = {},
): Promise<CallToolResult> {
  const a = args ?? {};
  const source: SyncSource =
    a.source === "cursor" ? "cursor" : a.source === "opencode" ? "opencode" : "claude_code";

  if (source === "cursor") {
    return errorResult(
      "gocode_sync_current_chat: Cursor chats sync automatically via the " +
        "installed stop hook (the MCP tool has no access to Cursor's current " +
        "conversation). Ensure `gocode-sync setup` has run and 'Sync my IDE " +
        "chat' is enabled in the GoCode app.",
    );
  }

  if (source === "opencode") {
    return errorResult(
      "gocode_sync_current_chat: OpenCode chats sync automatically via the " +
        "installed session.idle plugin (the MCP tool has no access to OpenCode's " +
        "current conversation). Ensure `gocode-sync setup` has run and 'Sync my " +
        "IDE chat' is enabled in the GoCode app.",
    );
  }

  const sessionId = process.env.CLAUDE_SESSION_ID;
  if (!sessionId) {
    return errorResult(
      "gocode_sync_current_chat: could not determine the current Claude session " +
        "(CLAUDE_SESSION_ID not set). The automatic stop hook handles this; the " +
        "MCP tool only works inside a Claude Code session.",
    );
  }

  const server = await resolveServerUrl(deps.serverFlag, deps);
  const result = await onSync({
    source,
    server,
    home: deps.home,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    claude: { sessionId },
  });

  switch (result.mode) {
    case "uploaded":
      return textResult("Synced your current chat to the GoCode app.");
    case "disabled":
      return errorResult(
        "Sync is OFF. Turn on 'Sync my IDE chat' in the GoCode app first " +
          "(it's off by default).",
      );
    case "nothing-to-sync":
      return errorResult("Nothing to sync — no current-session transcript was found.");
    case "not-paired":
      return errorResult("Not paired — ask the user to run `gocode-notify login`.");
    default:
      return errorResult(`Could not sync: ${result.detail ?? result.mode}.`);
  }
}

/** Handle the status tool. */
export async function handleStatus(deps: McpDeps = {}): Promise<CallToolResult> {
  const creds = await readCredentials(deps).catch(() => null);
  const lines: string[] = [];
  if (!creds) {
    lines.push("Credentials: NOT paired — run `gocode-notify login`.");
    return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
  }
  lines.push(`Credentials: paired as ${creds.user_id} (${creds.label}).`);
  const settings = await fetchSyncSettings({
    source: "cursor",
    home: deps.home,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    server: await resolveServerUrl(deps.serverFlag, deps),
  });
  lines.push(
    `IDE chat sync: ${settings.enabled ? "ENABLED" : "disabled (default — turn it on in the GoCode app)"}.`,
  );
  return { content: [{ type: "text", text: lines.join("\n") }], isError: !settings.enabled };
}

/** Build the MCP server with the two tools registered (pure — no network). */
export function createMcpServer(deps: McpDeps = {}): Server {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOLS] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === SYNC_TOOL) {
      return handleSync(args as Record<string, unknown> | undefined, deps);
    }
    if (name === STATUS_TOOL) {
      return handleStatus(deps);
    }
    return errorResult(`Unknown tool: ${name}`);
  });

  return server;
}

/** Run the MCP server over stdio until the client disconnects. */
export async function serveStdio(deps: McpDeps = {}): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
}
