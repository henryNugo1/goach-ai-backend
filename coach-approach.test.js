import test from "node:test";
import assert from "node:assert/strict";
import { resolveBodyApproach, messagesFromTranscript } from "./coach-approach.js";
const user = content => ({ role: "user", content });
const assistant = content => ({ role: "assistant", content });
const choice = assistant("Would you prefer food, movement, daily habits, or another approach?");

test("home/gym choices cannot select food plus movement", () => {
  const messages = [user("Hi do u know workouts"), assistant("What do you want the workout to help you with?"), user("Muscle gain"),
    assistant("For muscle gain you need workout, enough food and rest. Do you want to train at home, in the gym, or both?"), user("Train at home")];
  assert.equal(resolveBodyApproach(messages).approach, "movement");
  messages[messages.length - 1] = user("Both");
  assert.equal(resolveBodyApproach(messages).approach, "movement");
  for (const reply of ["Selected days", "Mon to Thurs", "7am", "Yes", "Change something", "What", "Nah its ok like that generate the plan", "I didnt say that", "Yes", "Yes"]) {
    messages.push(assistant("Since you chose both food and workout, send the workout time and your meal times."), user(reply));
    assert.equal(resolveBodyApproach(messages).approach, "movement");
  }
});

test("food rejection preserves a workout-only choice", () => {
  assert.deepEqual(resolveBodyApproach([user("Train at home"), user("I didnt say food")]), { approach: "movement", corrected: false });
  assert.deepEqual(resolveBodyApproach([choice, user("Both"), user("I didnt say that")]), { approach: null, corrected: true });
});

test("reported conversation never confirms both from the assistant or a duration yes", () => {
  const messages = [user("I want to loose weight"),
    assistant("Since you chose both food and workout, send your meal times and workout time."),
    user("I didnt say workout")];
  assert.deepEqual(resolveBodyApproach(messages), { approach: null, corrected: true });
  messages.push(assistant("For this I recommend 8 weeks. Is that okay?"), user("Yes"));
  assert.equal(resolveBodyApproach(messages).approach, null);
});
test("both requires a relevant user choice", () => {
  assert.equal(resolveBodyApproach([choice, user("Both")]).approach, "both");
  assert.equal(resolveBodyApproach([user("I want food and exercise")]).approach, "both");
  assert.equal(resolveBodyApproach([assistant("Do you want both food and exercise?"), user("Yes")]).approach, "both");
  assert.equal(resolveBodyApproach([assistant("8 weeks or 12 weeks?"), user("Both")]).approach, null);
});
test("later correction revokes an earlier choice and an explicit alternative can replace it", () => {
  const messages = [choice, user("Both"), user("No workout")];
  assert.equal(resolveBodyApproach(messages).approach, null);
  messages.push(choice, user("Food only"));
  assert.equal(resolveBodyApproach(messages).approach, "food");
});
test("daily habits and other approaches do not cause repeated selection questions", () => {
  assert.equal(resolveBodyApproach([choice, user("Daily habits")]).approach, "habits");
  assert.equal(resolveBodyApproach([choice, user("Focus on hydration")]).approach, "other");
});
test("transcript preserves roles instead of counting assistant suggestions as choices", () => {
  const messages = messagesFromTranscript("1. USER: I want to lose weight\n2. ASSISTANT: Since you chose both food and workout\n3. USER: I did not say workout");
  assert.equal(messages.length, 3);
  assert.deepEqual(resolveBodyApproach(messages), { approach: null, corrected: true });
});
