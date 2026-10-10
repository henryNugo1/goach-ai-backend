export const getNormalizedPlan = (profile = {}, now = Date.now()) => {
  const plan = String(profile.plan || "free");
  const status = String(profile.subscription_status || "");
  const end = profile.current_period_ends_at
    ? Date.parse(profile.current_period_ends_at)
    : NaN;
  const periodIsCurrent = Number.isFinite(end) && end > now;

  if (["mini", "standard", "premium"].includes(plan)) {
    if (status === "cancelled" && periodIsCurrent) return plan;
    if (status === "active" && (periodIsCurrent ||
      (!profile.current_period_ends_at && profile.subscription_provider !== "google_play"))) return plan;
  }

  if (status === "trialing" && profile.trial_ends_at &&
    Date.parse(profile.trial_ends_at) > now) return "trial";
  return "free";
};
