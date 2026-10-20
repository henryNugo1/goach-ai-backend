import { GoogleAuth } from "google-auth-library";

export const PLAY_PACKAGE_NAME = "com.nugo.pida";
export const PLAY_MINI_PRODUCT_ID = "pida_mini_monthly";
export const PLAY_MINI_BASE_PLAN_ID = "monthly";
export const PLAY_STANDARD_PRODUCT_ID = "pida_standard_monthly";
export const PLAY_PREMIUM_PRODUCT_ID = "pida_premium_monthly";
export const PLAY_PRODUCTS = {
  [PLAY_MINI_PRODUCT_ID]: { plan: "mini", credits: 50 },
  [PLAY_STANDARD_PRODUCT_ID]: { plan: "standard", credits: 150 },
  [PLAY_PREMIUM_PRODUCT_ID]: { plan: "premium", credits: 250 },
};

let auth;

const getAuth = () => {
  if (!auth) {
    const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("Google Play billing is not configured");
    auth = new GoogleAuth({
      credentials: JSON.parse(raw),
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
  }
  return auth;
};

const requestPlay = async (path, method = "GET") => {
  const client = await getAuth().getClient();
  const response = await client.request({
    url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PLAY_PACKAGE_NAME}/${path}`,
    method,
    ...(method === "POST" ? { data: {} } : {}),
  });
  return response.data;
};

export const getPlaySubscription = (purchaseToken) =>
  requestPlay(`purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);

export const getPlayProduct = (purchaseToken) =>
  requestPlay(`purchases/productsv2/tokens/${encodeURIComponent(purchaseToken)}`);

export const consumePlayProduct = (purchaseToken, productId) =>
  requestPlay(`purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:consume`, "POST");

export const acknowledgePlaySubscription = (purchaseToken, productId) =>
  requestPlay(
    `purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
    "POST",
  );

export const parsePlaySubscription = (purchase) => {
  // subscriptionsv2.get is scoped to the package in the request URL; its response has no packageName.
  const states = new Set([
    "SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_CANCELED",
    "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", "SUBSCRIPTION_STATE_ON_HOLD",
    "SUBSCRIPTION_STATE_PAUSED", "SUBSCRIPTION_STATE_EXPIRED",
    "SUBSCRIPTION_STATE_PENDING", "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED",
  ]);
  if (!states.has(purchase?.subscriptionState)) return null;

  const lineItem = purchase.lineItems?.find(
    (item) => PLAY_PRODUCTS[item.productId] &&
      item.offerDetails?.basePlanId === PLAY_MINI_BASE_PLAN_ID,
  );
  if (!lineItem) return null;

  const expiresAt = lineItem.expiryTime ? new Date(lineItem.expiryTime) : null;
  if (expiresAt && !Number.isFinite(expiresAt.getTime())) return null;
  const entitled = ["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_CANCELED", "SUBSCRIPTION_STATE_IN_GRACE_PERIOD"].includes(purchase.subscriptionState) && Boolean(expiresAt && expiresAt > new Date());

  return {
    productId: lineItem.productId,
    plan: PLAY_PRODUCTS[lineItem.productId].plan,
    credits: PLAY_PRODUCTS[lineItem.productId].credits,
    state: purchase.subscriptionState,
    entitled,
    orderId: lineItem.latestSuccessfulOrderId || null,
    expiresAt: expiresAt?.toISOString() || null,
    linkedPurchaseToken: purchase.linkedPurchaseToken || null,
    cancelAtPeriodEnd: purchase.subscriptionState === "SUBSCRIPTION_STATE_CANCELED",
  };
};

export const parseMiniSubscription = (purchase) => {
  const parsed = parsePlaySubscription(purchase);
  return parsed?.productId === PLAY_MINI_PRODUCT_ID ? parsed : null;
};
