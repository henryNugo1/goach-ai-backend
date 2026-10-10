import assert from "node:assert/strict";
import { test } from "node:test";
import { getNormalizedPlan } from "./billing-access.js";

const now = Date.parse("2026-10-10T12:00:00Z");
const profile = (overrides = {}) => ({
  plan: "mini",
  subscription_status: "active",
  subscription_provider: "paystack",
  current_period_ends_at: "2026-10-11T12:00:00Z",
  ...overrides,
});

test("active subscriptions get their paid plan only during the saved period", () => {
  assert.equal(getNormalizedPlan(profile(), now), "mini");
  assert.equal(getNormalizedPlan(profile({ current_period_ends_at: "2026-09-07T12:00:00Z" }), now), "free");
  assert.equal(getNormalizedPlan(profile({ current_period_ends_at: null }), now), "mini");
  assert.equal(getNormalizedPlan(profile({ subscription_provider: "google_play", current_period_ends_at: null }), now), "free");
});

test("cancelled subscriptions stop receiving plan benefits after paid-through date", () => {
  assert.equal(getNormalizedPlan(profile({ subscription_status: "cancelled" }), now), "mini");
  assert.equal(getNormalizedPlan(profile({ subscription_status: "cancelled", current_period_ends_at: "2026-09-07T12:00:00Z" }), now), "free");
  assert.equal(getNormalizedPlan(profile({ subscription_status: "cancelled", current_period_ends_at: null }), now), "free");
});

test("inactive and expired trials do not imply a paid plan", () => {
  assert.equal(getNormalizedPlan(profile({ subscription_status: "expired" }), now), "free");
  assert.equal(getNormalizedPlan(profile({ subscription_status: "trialing", trial_ends_at: "2026-10-11T12:00:00Z" }), now), "trial");
  assert.equal(getNormalizedPlan(profile({ subscription_status: "trialing", trial_ends_at: "2026-09-07T12:00:00Z" }), now), "free");
});
