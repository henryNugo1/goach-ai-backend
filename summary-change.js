export function asksToChangeSomething(message = "") {
  const text = String(message).toLowerCase().replace(/[.!?,]/g, "").replace(/\s+/g, " ").trim();
  return /^(?:please )?(?:change something|i want to change something|id like to change something|i'd like to change something)(?: please)?$/.test(text);
}

export function waitForChangeDetails(goalDraft) {
  return {
    ...goalDraft,
    finalSummaryConfirmed: false,
    finalSummaryOffered: false,
    lastQuestionType: "change_details",
    lastQuestionWasFinal: false,
  };
}
