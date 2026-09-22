export function wantsToKeepPlan(message = "") {
  const text = String(message).toLowerCase().replace(/[’']/g, "").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  return /^(?:(?:no|nah|please|pls|just|okay|ok) )*(?:keep it(?: as (?:it is|is))?|leave it(?: as (?:it is|is))?|keep (?:the )?plan(?: unchanged| as it is)?|no changes|dont (?:change|update) (?:it|the plan)|do not (?:change|update) (?:it|the plan))(?: please| thanks)?$/.test(text);
}
