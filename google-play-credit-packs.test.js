import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createPlayCreditPackHandler, parsePlayCreditPack } from "./google-play-credit-packs.js";

const fixture = (productId = "pida_credits_50") => ({
  orderId: "GPA.test-order", obfuscatedExternalAccountId: createHash("sha256").update("owner").digest("hex"),
  purchaseStateContext: { purchaseState: "PURCHASED" },
  productLineItem: [{ productId, productOfferDetails: { purchaseOptionId: "one-time", quantity: 1,
    refundableQuantity: 1, consumptionState: "CONSUMPTION_STATE_YET_TO_BE_CONSUMED" } }],
});
test("all packs use verified product identity and reject incomplete, refunded or unsupported purchases", () => {
  for (const amount of [50, 150, 250]) {
    const id = `pida_credits_${amount}`;
    assert.equal(parsePlayCreditPack(fixture(id), id).credits, amount);
  }
  for (const state of ["PENDING", "CANCELLED", "PURCHASE_STATE_UNSPECIFIED"]) {
    const p = fixture(); p.purchaseStateContext.purchaseState = state;
    assert.equal(parsePlayCreditPack(p, "pida_credits_50"), null);
  }
  for (const changes of [{ quantity: 2 }, { refundableQuantity: 0 }, { purchaseOptionId: "other" },
    { consumptionState: "unknown" }, { rentOfferDetails: {} }]) {
    const p = fixture(); Object.assign(p.productLineItem[0].productOfferDetails, changes);
    assert.equal(parsePlayCreditPack(p, "pida_credits_50"), null);
  }
  assert.equal(parsePlayCreditPack(fixture(), "pida_credits_250"), null);
  assert.equal(parsePlayCreditPack(fixture(), "toString"), null);
  const missingOrder = fixture(); delete missingOrder.orderId;
  assert.equal(parsePlayCreditPack(missingOrder, "pida_credits_50"), null);
});

const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
test("verification binds account and grants before consumption; retries safely finish failed consumption", async () => {
  let grantCount = 0, calls = 0, failConsume = true;
  const handler = createPlayCreditPackHandler({
    getPurchase: async () => fixture(),
    db: { rpc: async () => { calls++; const credited = grantCount === 0; if (credited) grantCount++;
      return { data: { credited, credits: 50 } }; } },
    consumePurchase: async () => { assert.equal(grantCount, 1); if (failConsume) throw new Error("network"); },
  });
  const request = { userId: "owner", body: { productId: "pida_credits_50", purchaseToken: "token" } };
  const wrong = response(); await handler({ ...request, userId: "other" }, wrong);
  assert.equal(wrong.statusCode, 403); assert.equal(calls, 0);
  const failed = response(); await handler(request, failed); assert.equal(failed.statusCode, 502);
  failConsume = false;
  const retry = response(); await handler(request, retry);
  assert.equal(retry.statusCode, 200); assert.equal(retry.body.credited, false);
  assert.equal(retry.body.consumed, true); assert.equal(grantCount, 1);
});
test("a failed ledger write never consumes the purchase", async () => {
  let consumed = false;
  const handler = createPlayCreditPackHandler({ getPurchase: async () => fixture(),
    consumePurchase: async () => { consumed = true; }, db: { rpc: async () => ({ error: new Error("db failure") }) } });
  const res = response();
  await handler({ userId: "owner", body: { productId: "pida_credits_50", purchaseToken: "token" } }, res);
  assert.equal(res.statusCode, 502); assert.equal(consumed, false);
});
