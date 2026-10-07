import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlayNotification } from "./google-play-notifications.js";

const message = (payload) => ({ message: { data: Buffer.from(JSON.stringify(payload)).toString("base64") } });

test("accepts only Pida Play notification envelopes", () => {
  assert.deepEqual(parsePlayNotification(message({ packageName: "com.nugo.pida", testNotification: {} })), { kind: "test" });
  assert.deepEqual(parsePlayNotification(message({ packageName: "com.nugo.pida", subscriptionNotification: { purchaseToken: "token", notificationType: 2 } })), { kind: "subscription", purchaseToken: "token" });
  assert.deepEqual(parsePlayNotification(message({ packageName: "com.nugo.pida", voidedPurchaseNotification: { purchaseToken: "token", orderId: "order", productType: 1, refundType: 1 } })), { kind: "voided", purchaseToken: "token", orderId: "order" });
  assert.deepEqual(parsePlayNotification(message({ packageName: "com.nugo.pida", voidedPurchaseNotification: { purchaseToken: "token", orderId: "order", productType: 2, refundType: 1 } })), { kind: "ignored" });
  assert.equal(parsePlayNotification(message({ packageName: "other.app", subscriptionNotification: { purchaseToken: "token" } })), null);
  assert.equal(parsePlayNotification({ message: { data: "not-base64!" } }), null);
});
