import { PLAY_PACKAGE_NAME } from "./google-play.js";

export const parsePlayNotification = (body) => {
  const encoded = body?.message?.data;
  if (typeof encoded !== "string" || !encoded || encoded.length > 65536 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (payload?.packageName !== PLAY_PACKAGE_NAME) return null;
  if (payload.testNotification) return { kind: "test" };
  const subscription = payload.subscriptionNotification;
  if (typeof subscription?.purchaseToken === "string" && subscription.purchaseToken.length <= 4096) {
    return { kind: "subscription", purchaseToken: subscription.purchaseToken };
  }
  const voided = payload.voidedPurchaseNotification;
  if (voided?.productType === 1 && voided.refundType === 1 &&
      typeof voided.purchaseToken === "string" && voided.purchaseToken.length <= 4096 &&
      typeof voided.orderId === "string" && voided.orderId.length <= 256) {
    return { kind: "voided", purchaseToken: voided.purchaseToken, orderId: voided.orderId };
  }
  return { kind: "ignored" };
};
