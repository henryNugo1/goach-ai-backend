export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export function extractBearerToken(authorizationHeader = "") {
  const match = String(authorizationHeader).match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

export function normalizeIdempotencyKey(value = "") {
  const key = String(value).trim();
  return IDEMPOTENCY_KEY_PATTERN.test(key) ? key : "";
}

