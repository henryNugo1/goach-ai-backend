import test from "node:test";
import assert from "node:assert/strict";
import { asksToChangeSomething, waitForChangeDetails } from "./summary-change.js";

test("generic change requests await details instead of confirming", () => {
  for (const text of ["Change something", "Change something", "Please change something."]) {
    assert.equal(asksToChangeSomething(text), true);
  }
  for (const text of ["Yes", "Change time to 7am", "What would you like to change?"]) {
    assert.equal(asksToChangeSomething(text), false);
  }
});
test("waiting clears confirmation flags without erasing schedule", () => {
  const draft = { finalSummaryConfirmed: true, finalSummaryOffered: true, lastQuestionWasFinal: true, selectedDays: ["Monday"], sessionTime: "18:00" };
  const next = waitForChangeDetails(draft);
  assert.equal(next.finalSummaryConfirmed, false);
  assert.equal(next.finalSummaryOffered, false);
  assert.equal(next.lastQuestionWasFinal, false);
  assert.equal(next.lastQuestionType, "change_details");
  assert.deepEqual(next.selectedDays, ["Monday"]);
  assert.equal(next.sessionTime, "18:00");
  assert.equal(draft.finalSummaryConfirmed, true);
});
