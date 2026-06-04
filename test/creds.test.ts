import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveServer,
  resolveServerWithSource,
  DEFAULT_SERVER,
} from "../src/creds.js";

test("resolveServer precedence: flag > env > creds > default", () => {
  assert.equal(
    resolveServer({ flag: "https://flag.test", env: "https://env.test", creds: { server: "https://creds.test" } }),
    "https://flag.test",
  );
  assert.equal(
    resolveServer({ env: "https://env.test", creds: { server: "https://creds.test" } }),
    "https://env.test",
  );
  assert.equal(resolveServer({ creds: { server: "https://creds.test" } }), "https://creds.test");
  assert.equal(resolveServer({}), DEFAULT_SERVER);
});

test("resolveServerWithSource reports the winning layer", () => {
  assert.deepEqual(resolveServerWithSource({ flag: "https://flag.test/" }), {
    server: "https://flag.test",
    source: "flag",
    usedBuiltInDefault: false,
  });
  assert.deepEqual(resolveServerWithSource({ env: "https://env.test" }).source, "env");
  assert.deepEqual(resolveServerWithSource({ creds: { server: "https://creds.test" } }).source, "creds");
});

test("usedBuiltInDefault is true ONLY when nothing is configured", () => {
  // The config-safety signal Sentinel flagged: an unconfigured self-hoster.
  assert.equal(resolveServerWithSource({}).usedBuiltInDefault, true);
  assert.equal(resolveServerWithSource({ creds: { server: "https://mine.test" } }).usedBuiltInDefault, false);
  assert.equal(resolveServerWithSource({ env: "https://mine.test" }).usedBuiltInDefault, false);
  assert.equal(resolveServerWithSource({ flag: "https://mine.test" }).usedBuiltInDefault, false);
});

test("trailing slashes are normalised away", () => {
  assert.equal(resolveServer({ flag: "https://x.test///" }), "https://x.test");
});
