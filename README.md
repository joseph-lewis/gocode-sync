# @trygocode/sync

> **What this does, in one line:** it uploads **only the single IDE chat you're
> currently working in** to **your own self-hosted GoCode server** so you can
> read it on your phone — never your other chats, never your files, never your
> history, and only when you explicitly turn it on (off by default).

`@trygocode/sync` is an **optional** companion to
[`@trygocode/notify`](https://www.npmjs.com/package/@trygocode/notify). Notify
pings your phone when a coding run finishes. This package adds one extra,
clearly-scoped capability: at the end of each turn it can sync the **current**
Cursor / Claude Code / OpenCode conversation up to your GoCode server so you can
pick up context on the go.

It is a **separate package on purpose.** Code that reads chat transcripts and
uploads them is exactly the shape security folks (rightly) scrutinise. By
keeping it out of the base `@trygocode/notify` package, that base package stays
auditably "notifications only — it never reads your conversation content," and
this package stays small enough to read end-to-end in a few minutes. Installing
it is a **deliberate, separate opt-in** — that's the point, not a wart.

---

## Security model (read this)

- **Scope: the current session only.** When the hook fires, we capture **only**
  the one conversation that triggered it (identified by the IDE's own session
  id). We do **not** enumerate or read any of your other chats. "Read every
  chat" is exactly the behaviour this package refuses to do.
- **Where it goes: your own server.** Transcripts upload to the GoCode server
  *you* paired with — your self-hosted instance, not a shared cloud. The URL is
  configurable (`--server`, `GOCODE_SERVER`, or your `~/.gocode/credentials`).
- **Per-user isolation.** On the server, transcripts live in a per-user,
  api-key-isolated store (the same isolation the notification endpoints use).
  The server processes everything inside per-user isolated Docker sandboxes —
  two users never see each other's data. (This isolation applies to the base
  notify path too, not just sync.)
- **Encrypted in transit.** HTTPS/TLS, the same secured path notifications use.
- **Off by default, double-gated.** Nothing uploads unless **both** are true:
  (1) you flip on *"Sync my IDE chat"* in the GoCode app, **and** (2) this
  package is installed. Turn either off and uploads stop immediately.
- **Best-effort redaction + size caps.** Before upload we mask common secret
  shapes (API keys, tokens, `Authorization: Bearer …`) and cap the payload
  size. This reduces accidental leakage — it is not a guarantee, which is part
  of why the feature is opt-in.
- **Never blocks your agent.** Every hook path is fire-and-forget: it never
  throws and always exits 0, so a slow or failed sync can't stall your turn.
- **Auditable.** This whole package is open source and intentionally tiny.
  Read `src/` — there's no hidden network call, no chat-harvesting, no
  telemetry.

---

## Install

You must already be paired with `@trygocode/notify` (sync reuses that pairing —
the same `~/.gocode/credentials`, no second login):

```bash
# 1. (if you haven't already) install + pair the base notifier
npx -y @trygocode/notify setup
npx -y @trygocode/notify login

# 2. add the optional chat-sync companion
npx -y @trygocode/sync setup
```

`setup` merges a second end-of-turn hook alongside your existing notify hook in
`~/.cursor/hooks.json` and `~/.claude/settings.json`. It never clobbers your own
hooks, and re-running it is idempotent.

Then, in the GoCode app, turn on Settings -> GoCode Notify -> "Sync my IDE chat
(preview)". Until you do, this package uploads nothing.

## Usage

Once installed + enabled, there's nothing to run by hand — the hook calls
`gocode-sync on-sync` automatically at the end of each turn. Useful commands:

```bash
gocode-sync status     # show pairing + whether sync is enabled server-side
gocode-sync on-sync --source cursor --dry-run --verbose   # see what it WOULD do
gocode-sync uninstall  # remove the sync hook (your notify hook stays)
gocode-sync mcp        # run the MCP server (used by the agent, see below)
```

`setup` also registers a tiny MCP server (`gocode_sync_current_chat` +
`gocode_sync_status`) so the agent can sync **on your explicit request**
("sync this chat to my phone"). The MCP tool funnels through the exact same
gated, current-session-only, redacted path as the hook — it can't sync a
different chat and it uploads nothing while the app toggle is off.

## Supported IDEs

| IDE | Status |
|---|---|
| Claude Code | supported (current session's JSONL) |
| Cursor | supported (current conversation from the hook payload) |
| OpenCode | supported (`session.idle` plugin → current session's messages via OpenCode's SDK) |

> **OpenCode** is wired via a tiny `session.idle` plugin written to
> `~/.config/opencode/plugin/gocode-sync.js`. When a session goes idle the
> plugin fetches **only that one session's** messages through OpenCode's own
> SDK (`client.session.messages`) and pipes them to `gocode-sync on-sync` — it
> never lists or reads other sessions, never touches the on-disk store, and
> obeys the same server-side opt-in gate. `npx @trygocode/sync uninstall`
> removes the plugin and its MCP entry surgically.

## How "no duplicates" works

Each synced chat is keyed on a deterministic id derived from
`(source, workspace path, IDE session id)`. The same IDE session always maps to
the same server record, so re-syncing a conversation updates it in place instead
of creating a new chat every turn. Start a new IDE session -> new id -> new chat.

## Uninstall

```bash
npx -y @trygocode/sync uninstall   # removes only the sync hook
```

Your `@trygocode/notify` hook and all your own config are left untouched.

## License

MIT
