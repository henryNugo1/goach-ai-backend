import assert from "node:assert/strict";
import test from "node:test";

import { extractBearerToken, normalizeIdempotencyKey } from "./goach-security.js";

test("extracts only bearer access tokens", () => {
  assert.equal(extractBearerToken("Bearer valid-token"), "valid-token");
  assert.equal(extractBearerToken("bearer another-token"), "another-token");
  assert.equal(extractBearerToken("Basic forged"), "");
  assert.equal(extractBearerToken(""), "");
});

test("accepts bounded opaque idempotency keys", () => {
  assert.equal(
    normalizeIdempotencyKey("9ee9b42e-6e8e-41e1-a385-33c74c32a39a"),
    "9ee9b42e-6e8e-41e1-a385-33c74c32a39a",
  );
  assert.equal(normalizeIdempotencyKey("short"), "");
  assert.equal(normalizeIdempotencyKey("invalid key with spaces"), "");
});

