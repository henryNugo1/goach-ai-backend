// Only user messages can select an approach. Assistant suggestions are context,
// not evidence that a user agreed to them.
export function resolveBodyApproach(messages = []) {
  let approach = null;
  let previousAssistant = "";
  let corrected = false;
  for (const message of messages) {
    const text = String(message?.content ?? "").toLowerCase().replace(/[’']/g, "");
    if (message?.role === "assistant") { previousAssistant = text; continue; }
    if (message?.role !== "user") continue;
    corrected = false;
    const movement = /\b(workouts?|work out|exercise|gym|walking|movement|train|training)\b/.test(text);
    const food = /\b(food|meals?|diet|nutrition|eating)\b/.test(text);
    const correction = /\b(didnt|did not|never)\s+(say|choose|select|ask|mention|agree)|\b(no|without|exclude|remove|dont want|do not want)\b/.test(text);
    if (correction && (movement || food)) {
      const previousApproach = approach;
      approach = null;
      corrected = true;
      // A positive alternative in the same message remains a valid choice.
      if (/\b(food|diet|nutrition|meals?)\s+only\b|\bonly\s+(food|diet|nutrition|meals?)\b/.test(text)) approach = "food";
      if (/\b(workouts?|exercise|movement)\s+only\b|\bonly\s+(workouts?|exercise|movement)\b/.test(text)) approach = "movement";
      if (food && !movement && previousApproach === "movement") approach = "movement";
      if (movement && !food && previousApproach === "food") approach = "food";
      corrected = !approach;
      continue;
    }
    if (correction && /\b(that|both)\b/.test(text) && approach === "both") {
      approach = null;
      corrected = true;
      continue;
    }
    // Only the current question defines what a short answer such as "both" means.
    const question = (previousAssistant.match(/[^.!?]*\?/g) ?? []).at(-1) ?? "";
    const choiceQuestion = /\b(food|meals?|diet|nutrition)\b/.test(question)
      && /\b(workouts?|exercise|movement)\b/.test(question)
      && /\b(prefer|focus|choose|approach|would you like|do you want)\b/.test(question)
      && !/\b(times?|weeks?|months?|duration)\b/.test(question);
    if ((food && movement) || (/^(both|both please)[.! ]*$/.test(text) && choiceQuestion)) approach = "both";
    else if (/^(yes|yes please|okay|ok)[.! ]*$/.test(text) && choiceQuestion && /\bboth\b/.test(question)
      && !/\bor\b/.test(question)) approach = "both";
    else if (/\b(daily habits?|sleep|stress|lifestyle)\b/.test(text) && !correction) approach = "habits";
    else if (food && !movement) approach = "food";
    else if (movement && !food) approach = "movement";
    else if (choiceQuestion && text.trim() && !/^(yes|no|ok|okay|not sure|i dont know)[.! ]*$/.test(text)) approach = "other";
  }
  return { approach, corrected };
}

export function messagesFromTranscript(text = "") {
  return [...String(text).matchAll(/(?:^|\n)(?:\d+\.\s*)?(USER|ASSISTANT):\s*([\s\S]*?)(?=\n(?:\d+\.\s*)?(?:USER|ASSISTANT):|$)/gi)]
    .map(match => ({ role: match[1].toLowerCase(), content: match[2] }));
}
