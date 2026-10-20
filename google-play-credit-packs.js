import { createHash } from "node:crypto";

const PRODUCTS = new Map([
  ["pida_credits_50", 50], ["pida_credits_150", 150], ["pida_credits_250", 250],
]);

export const parsePlayCreditPack = (purchase, productId) => {
  if (!PRODUCTS.has(productId) || purchase?.purchaseStateContext?.purchaseState !== "PURCHASED"
    || typeof purchase.orderId !== "string" || !purchase.orderId.trim() || purchase.orderId.length > 256
    || !Array.isArray(purchase.productLineItem) || purchase.productLineItem.length !== 1) return null;
  const item = purchase.productLineItem[0];
  const offer = item?.productOfferDetails;
  if (item?.productId !== productId || offer?.purchaseOptionId !== "one-time"
    || offer.quantity !== 1 || offer.refundableQuantity !== 1 || offer.rentOfferDetails
    || !["CONSUMPTION_STATE_YET_TO_BE_CONSUMED", "CONSUMPTION_STATE_CONSUMED"].includes(offer.consumptionState)) return null;
  return { productId, orderId: purchase.orderId, credits: PRODUCTS.get(productId),
    consumed: offer.consumptionState === "CONSUMPTION_STATE_CONSUMED" };
};

export const createPlayCreditPackHandler = ({ getPurchase, consumePurchase, db }) => async (req, res) => {
  const { purchaseToken, productId } = req.body || {};
  if (typeof purchaseToken !== "string" || !purchaseToken.trim() || purchaseToken.length > 4096 || !PRODUCTS.has(productId)) {
    return res.status(400).json({ error: "A valid Play credit-pack purchase is required." });
  }
  try {
    const purchase = await getPurchase(purchaseToken);
    const accountId = createHash("sha256").update(req.userId).digest("hex");
    if (purchase?.obfuscatedExternalAccountId !== accountId) {
      return res.status(403).json({ error: "This purchase belongs to another Pida account." });
    }
    const verified = parsePlayCreditPack(purchase, productId);
    if (!verified) return res.status(409).json({ error: "This credit-pack payment is not complete or is no longer valid." });
    const { data, error } = await db.rpc("credit_verified_play_pack", {
      p_user_id: req.userId, p_product_id: productId, p_purchase_token: purchaseToken,
      p_order_id: verified.orderId, p_consumed: verified.consumed,
    });
    if (error) throw error;
    if (!data || typeof data.credited !== "boolean" || data.credits !== verified.credits) throw new Error("Invalid grant result");
    // Grant commits first. Retrying after a consume failure reuses the same ledger entry.
    if (!verified.consumed) await consumePurchase(purchaseToken, productId);
    return res.json({ ok: true, credited: data.credited, credits: data.credits, consumed: true });
  } catch (error) {
    console.error("Play credit-pack verification failed", error?.code || error?.status || "unknown");
    return res.status(502).json({ error: "Could not finish your credit-pack purchase. Reopen Credit Packs to retry." });
  }
};
