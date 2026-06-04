import { test } from "node:test";
import assert from "node:assert/strict";
import { onSync } from "../src/sync.js";
import type { CapturedTranscript } from "../src/transcript.js";
import type { UploadResult } from "../src/upload.js";

const sampleTranscript: CapturedTranscript = {
  source: "cursor",
  ide_session_id: "s1",
  workspace_path: "/w",
  messages: [{ role: "user", content: "hi" }],
};

test("onSync is a no-op when the server gate is disabled (fail-closed)", async () => {
  let uploaded = false;
  const res = await onSync({
    source: "cursor",
    fetchSettings: async () => ({ enabled: false }),
    captureImpl: async () => sampleTranscript,
    uploadImpl: async () => {
      uploaded = true;
      return { ok: true } as UploadResult;
    },
    log: () => {},
  });
  assert.equal(res.mode, "disabled");
  assert.equal(uploaded, false, "must NOT upload when disabled");
});

test("onSync uploads when enabled and a transcript is captured", async () => {
  let uploadedTranscript: CapturedTranscript | undefined;
  const res = await onSync({
    source: "cursor",
    fetchSettings: async () => ({ enabled: true }),
    captureImpl: async () => sampleTranscript,
    uploadImpl: async (t) => {
      uploadedTranscript = t;
      return { ok: true, externalChatId: "deadbeef" } as UploadResult;
    },
    log: () => {},
  });
  assert.equal(res.mode, "uploaded");
  assert.ok(res.upload?.ok);
  assert.ok(uploadedTranscript);
  // content was redacted/sanitised but the single message survives
  assert.equal(uploadedTranscript!.messages.length, 1);
});

test("onSync no-ops when nothing is capturable", async () => {
  const res = await onSync({
    source: "cursor",
    fetchSettings: async () => ({ enabled: true }),
    captureImpl: async () => null,
    uploadImpl: async () => ({ ok: true } as UploadResult),
    log: () => {},
  });
  assert.equal(res.mode, "nothing-to-sync");
});

test("onSync dry-run captures but never uploads", async () => {
  let uploaded = false;
  const res = await onSync({
    source: "cursor",
    dryRun: true,
    fetchSettings: async () => ({ enabled: true }),
    captureImpl: async () => sampleTranscript,
    uploadImpl: async () => {
      uploaded = true;
      return { ok: true } as UploadResult;
    },
    log: () => {},
  });
  assert.equal(res.mode, "dry-run");
  assert.equal(uploaded, false);
});

test("onSync never throws even if capture/upload blow up", async () => {
  const res = await onSync({
    source: "cursor",
    fetchSettings: async () => ({ enabled: true }),
    captureImpl: async () => {
      throw new Error("boom");
    },
    log: () => {},
  });
  assert.equal(res.mode, "error");
});

test("onSync redacts secrets before upload", async () => {
  let captured: CapturedTranscript | undefined;
  await onSync({
    source: "cursor",
    fetchSettings: async () => ({ enabled: true }),
    captureImpl: async () => ({
      source: "cursor",
      ide_session_id: "s",
      workspace_path: "/w",
      messages: [{ role: "user", content: "my token ghp_ABCDEFGHIJKLMNOPQRSTuvwx0123" }],
    }),
    uploadImpl: async (t) => {
      captured = t;
      return { ok: true } as UploadResult;
    },
    log: () => {},
  });
  assert.match(captured!.messages[0].content, /«redacted»/);
});
