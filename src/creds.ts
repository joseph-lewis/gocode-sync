// Shared-credentials reader for @trygocode/sync.
//
// The sync companion deliberately reuses the SAME pairing as @trygocode/notify:
// the secret api-key + server URL live in `~/.gocode/credentials` (written by
// `gocode-notify login`/`setup`). We READ that file directly rather than
// importing notify's internals — this keeps the runtime zero-dependency, keeps
// the two packages decoupled, and keeps the trust story simple: sync reads the
// same credentials file you already created for notifications; it does not
// invent a new secret store.
//
// Server-URL precedence mirrors notify (PRD §4.2):
//   --server flag  >  GOCODE_SERVER env  >  credentials file  >  built-in default
//
// Zero runtime deps — Node built-ins only.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Built-in default server. Overridable at every layer — never assume the
 *  author's box; users point this at THEIR OWN self-hosted GoCode server. */
export const DEFAULT_SERVER = "https://oh.jeltechsolutions.com";

/** Secret pairing credentials, written by `gocode-notify login`/`setup`. */
export interface Credentials {
  api_key: string;
  server: string;
  user_id: string;
  label: string;
}

/** Optional override for the home directory — lets tests target a temp HOME. */
export interface PathOpts {
  home?: string;
}

/** Resolve the home dir: explicit override → $HOME → os.homedir(). */
export function resolveHome(opts?: PathOpts): string {
  return opts?.home ?? process.env.HOME ?? os.homedir();
}

/** Absolute path to the shared `~/.gocode/` directory. */
export function gocodeDir(opts?: PathOpts): string {
  return path.join(resolveHome(opts), ".gocode");
}

/** Absolute path to the shared secret credentials file. */
export function credentialsPath(opts?: PathOpts): string {
  return path.join(gocodeDir(opts), "credentials");
}

/** Trim a URL and strip trailing slashes so `${server}/path` is clean. */
function normalizeServer(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `~/.gocode/credentials`. Returns null when the file does not exist
 * (i.e. the user never ran `gocode-notify login`). Throws if it exists but is
 * malformed, so callers surface a clear "re-pair" error rather than a silent
 * no-op.
 */
export async function readCredentials(opts?: PathOpts): Promise<Credentials | null> {
  let raw: string;
  try {
    raw = await fs.readFile(credentialsPath(opts), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`gocode-sync: ${credentialsPath(opts)} contains invalid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`gocode-sync: ${credentialsPath(opts)} is not a JSON object`);
  }
  for (const field of ["api_key", "server", "user_id", "label"] as const) {
    if (typeof parsed[field] !== "string") {
      throw new Error(`gocode-sync: credentials missing string field "${field}"`);
    }
  }
  return {
    api_key: parsed.api_key as string,
    server: parsed.server as string,
    user_id: parsed.user_id as string,
    label: parsed.label as string,
  };
}

/** Inputs to {@link resolveServer}, in descending precedence order. */
export interface ServerSources {
  flag?: string | null;
  env?: string | null;
  creds?: { server?: string } | null;
  default?: string;
}

/** Resolve the effective server URL: flag > env > creds.server > default. */
export function resolveServer(sources: ServerSources): string {
  return resolveServerWithSource(sources).server;
}

/**
 * Like {@link resolveServer} but also reports WHICH layer won, so callers can
 * warn when they fell through to the built-in default. `usedBuiltInDefault` is
 * true only when no flag, env, or paired `creds.server` supplied a value — i.e.
 * the one case where an unconfigured self-hoster could accidentally upload to
 * the project's hosted default instead of their own box (config-safety).
 */
export function resolveServerWithSource(sources: ServerSources): {
  server: string;
  source: "flag" | "env" | "creds" | "default";
  usedBuiltInDefault: boolean;
} {
  const fromConfigured = firstNonEmpty(
    sources.flag,
    sources.env,
    sources.creds?.server,
  );
  if (fromConfigured !== undefined) {
    const source = firstNonEmpty(sources.flag)
      ? "flag"
      : firstNonEmpty(sources.env)
        ? "env"
        : "creds";
    return {
      server: normalizeServer(fromConfigured),
      source,
      usedBuiltInDefault: false,
    };
  }
  const fallback = sources.default ?? DEFAULT_SERVER;
  return {
    server: normalizeServer(fallback),
    source: "default",
    usedBuiltInDefault: true,
  };
}

let _warnedDefaultServer = false;

/** Convenience: resolve server URL from --server flag, GOCODE_SERVER env, creds. */
export async function resolveServerUrl(flag?: string, opts?: PathOpts): Promise<string> {
  let creds: Credentials | null = null;
  try {
    creds = await readCredentials(opts);
  } catch {
    creds = null;
  }
  const resolved = resolveServerWithSource({
    flag,
    env: process.env.GOCODE_SERVER ?? null,
    creds,
  });
  // One-time, non-fatal heads-up: a self-hoster who never paired and never set
  // --server / GOCODE_SERVER would otherwise silently target the project's
  // hosted default. Warn (stderr) so it's visible without breaking the flow.
  if (resolved.usedBuiltInDefault && !_warnedDefaultServer) {
    _warnedDefaultServer = true;
    process.stderr.write(
      `[gocode-sync] No server configured (no pairing, --server, or GOCODE_SERVER); ` +
        `falling back to the built-in default ${resolved.server}. ` +
        `Point this at YOUR OWN GoCode server with \`gocode-notify login\` or ` +
        `--server / GOCODE_SERVER if that is not what you want.\n`,
    );
  }
  return resolved.server;
}
