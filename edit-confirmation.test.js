import test from "node:test";
import assert from "node:assert/strict";
import { wantsToKeepPlan } from "./edit-confirmation.js";

test("explicit keep replies end the edit clarification", () => {
  for (const reply of ["Keep it", "Keep it", "Keep it as it is", "No, keep it", "Please leave it", "Don't change it", "No changes"]) {
    assert.equal(wantsToKeepPlan(reply), true, reply);
  }
});
test("greetings and partial edits do not cancel an edit", () => {
  for (const reply of ["Hi", "Update it", "Keep it simple", "Keep it but change Monday", "Keep the time and change the days", "Yes"]) {
    assert.equal(wantsToKeepPlan(reply), false, reply);
  }
});
