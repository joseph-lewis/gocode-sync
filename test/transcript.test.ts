import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveExternalChatId, normaliseRole } from "../src/transcript.js";

test("deriveExternalChatId is deterministic for the same session", () => {
  const a = deriveExternalChatId({ source: "cursor", workspace_path: "/work/repo", ide_session_id: "abc" });
  const b = deriveExternalChatId({ source: "cursor", workspace_path: "/work/repo", ide_session_id: "abc" });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test("deriveExternalChatId differs across session / source / workspace", () => {
  const base = { source: "cursor" as const, workspace_path: "/work/repo", ide_session_id: "abc" };
  assert.notEqual(deriveExternalChatId(base), deriveExternalChatId({ ...base, ide_session_id: "xyz" }));
  assert.notEqual(deriveExternalChatId(base), deriveExternalChatId({ ...base, source: "claude_code" }));
  assert.notEqual(deriveExternalChatId(base), deriveExternalChatId({ ...base, workspace_path: "/other" }));
});

test("deriveExternalChatId normalises case for source+path but not session id", () => {
  const lower = deriveExternalChatId({ source: "cursor", workspace_path: "/Work/Repo", ide_session_id: "Abc" });
  const upper = deriveExternalChatId({ source: "cursor", workspace_path: "/work/repo", ide_session_id: "Abc" });
  assert.equal(lower, upper, "path case should not fork the id");
  const diffSession = deriveExternalChatId({ source: "cursor", workspace_path: "/work/repo", ide_session_id: "abc" });
  assert.notEqual(upper, diffSession, "session id case IS significant");
});

test("normaliseRole maps known + unknown roles", () => {
  assert.equal(normaliseRole("user"), "user");
  assert.equal(normaliseRole("human"), "user");
  assert.equal(normaliseRole("system"), "system");
  assert.equal(normaliseRole("tool_result"), "tool");
  assert.equal(normaliseRole("assistant"), "assistant");
  assert.equal(normaliseRole("weird"), "assistant");
  assert.equal(normaliseRole(undefined), "assistant");
});
