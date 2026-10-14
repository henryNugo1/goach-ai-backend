import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMiniSubscription, parsePlaySubscription } from "./google-play.js";

const activePurchase = () => ({
  subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
  lineItems: [{
    productId: "pida_mini_monthly",
    offerDetails: { basePlanId: "monthly" },
    latestSuccessfulOrderId: "GPA.1234-5678-9012-34567..0",
    expiryTime: new Date(Date.now() + 86400000).toISOString(),
  }],
});

test("recognizes Standard monthly without treating it as Mini", () => {
  const purchase = activePurchase();
  purchase.lineItems[0].productId = "pida_standard_monthly";
  const parsed = parsePlaySubscription(purchase);
  assert.equal(parsed?.plan, "standard");
  assert.equal(parsed?.credits, 150);
  assert.equal(parsed?.productId, "pida_standard_monthly");
  assert.equal(parseMiniSubscription(purchase), null);
  purchase.lineItems[0].offerDetails.basePlanId = "annual";
  assert.equal(parsePlaySubscription(purchase), null);
});

test("recognizes Premium monthly and rejects an unsupported base plan", () => {
  const purchase = activePurchase();
  purchase.lineItems[0].productId = "pida_premium_monthly";
  const parsed = parsePlaySubscription(purchase);
  assert.equal(parsed?.plan, "premium");
  assert.equal(parsed?.credits, 250);
  assert.equal(parsed?.productId, "pida_premium_monthly");
  purchase.lineItems[0].offerDetails.basePlanId = "annual";
  assert.equal(parsePlaySubscription(purchase), null);
});

test("classifies Mini lifecycle without granting access during hold or expiry", () => {
  const purchase = activePurchase();
  assert.equal(parseMiniSubscription(purchase)?.entitled, true);
  assert.equal(parseMiniSubscription(purchase)?.orderId, purchase.lineItems[0].latestSuccessfulOrderId);
  assert.equal(parseMiniSubscription({ ...purchase, subscriptionState: "SUBSCRIPTION_STATE_CANCELED" })?.cancelAtPeriodEnd, true);
  assert.equal(parseMiniSubscription({ ...purchase, subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD" })?.entitled, true);
  assert.equal(parseMiniSubscription({ ...purchase, subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD" })?.entitled, false);
  assert.equal(parseMiniSubscription({ ...purchase, subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" })?.entitled, false);
  assert.equal(parseMiniSubscription({ ...purchase, lineItems: [{ ...purchase.lineItems[0], productId: "other_product" }] }), null);
  assert.equal(parseMiniSubscription({ ...purchase, lineItems: [{ ...purchase.lineItems[0], offerDetails: { basePlanId: "yearly" } }] }), null);
  assert.equal(parseMiniSubscription({ ...purchase, lineItems: [{ ...purchase.lineItems[0], expiryTime: "2020-01-01T00:00:00Z" }] })?.entitled, false);
  assert.equal(parseMiniSubscription({ ...purchase, lineItems: [{ ...purchase.lineItems[0], latestSuccessfulOrderId: undefined }] })?.orderId, null);
  assert.equal(parseMiniSubscription({ ...purchase, subscriptionState: "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED", linkedPurchaseToken: "old-token" })?.entitled, false);
  assert.equal(parseMiniSubscription({ ...purchase, subscriptionState: "SUBSCRIPTION_STATE_PENDING", linkedPurchaseToken: "old-token", lineItems: [{ ...purchase.lineItems[0], expiryTime: undefined }] })?.entitled, false);
});
