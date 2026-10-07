import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMiniSubscription } from "./google-play.js";

const activePurchase = () => ({
  packageName: "com.nugo.pida",
  subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
  lineItems: [{
    productId: "pida_mini_monthly",
    offerDetails: { basePlanId: "monthly" },
    latestSuccessfulOrderId: "GPA.1234-5678-9012-34567..0",
    expiryTime: new Date(Date.now() + 86400000).toISOString(),
  }],
});

test("classifies Mini lifecycle without granting access during hold or expiry", () => {
  const purchase = activePurchase();
  assert.equal(parseMiniSubscription(purchase)?.entitled, true);
  assert.equal(parseMiniSubscription(purchase)?.orderId, purchase.lineItems[0].latestSuccessfulOrderId);
  assert.equal(parseMiniSubscription({ ...purchase, subscriptionState: "SUBSCRIPTION_STATE_CANCELED" })?.cancelAtPeriodEnd, true);
  assert.equal(parseMiniSubscription({ ...purchase, subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD" })?.entitled, true);
  assert.equal(parseMiniSubscription({ ...purchase, subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD" })?.entitled, false);
  assert.equal(parseMiniSubscription({ ...purchase, subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" })?.entitled, false);
  assert.equal(parseMiniSubscription({ ...purchase, packageName: "other.app" }), null);
  assert.equal(parseMiniSubscription({ ...purchase, lineItems: [{ ...purchase.lineItems[0], offerDetails: { basePlanId: "yearly" } }] }), null);
  assert.equal(parseMiniSubscription({ ...purchase, lineItems: [{ ...purchase.lineItems[0], expiryTime: "2020-01-01T00:00:00Z" }] })?.entitled, false);
  assert.equal(parseMiniSubscription({ ...purchase, lineItems: [{ ...purchase.lineItems[0], latestSuccessfulOrderId: undefined }] })?.orderId, null);
  assert.equal(parseMiniSubscription({ ...purchase, subscriptionState: "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED", linkedPurchaseToken: "old-token" })?.entitled, false);
  assert.equal(parseMiniSubscription({ ...purchase, subscriptionState: "SUBSCRIPTION_STATE_PENDING", linkedPurchaseToken: "old-token", lineItems: [{ ...purchase.lineItems[0], expiryTime: undefined }] })?.entitled, false);
});
