import cors from "cors";
import { createHmac, timingSafeEqual } from "crypto";
import dotenv from "dotenv";
import express from "express";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";


dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({
  verify: (req, res, buffer) => {
    req.rawBody = buffer;
  },
}));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const UNSPLASH_APP_NAME = process.env.UNSPLASH_APP_NAME || "goaltracker_pro";
const TESTER_PASSWORD = process.env.TESTER_PASSWORD;

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PREMIUM_PLAN_CODE = process.env.PAYSTACK_PREMIUM_PLAN_CODE;
const PAYSTACK_MINI_PLAN_CODE = process.env.PAYSTACK_MINI_PLAN_CODE;
const PAYSTACK_STANDARD_PLAN_CODE = process.env.PAYSTACK_STANDARD_PLAN_CODE;
const APP_BILLING_CALLBACK_URL =
  process.env.APP_BILLING_CALLBACK_URL || "https://example.com/billing/callback";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESET_EMAIL_FROM =
  process.env.RESET_EMAIL_FROM || "GoalTracker Pro <onboarding@resend.dev>";

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

    const passwordResetCodes = new Map();

const createResetCode = () => {
  return String(Math.floor(100000 + Math.random() * 900000));
};

const normalizeEmail = (email = "") => {
  return String(email).trim().toLowerCase();
};

const sendResetEmail = async ({ email, code }) => {
  if (!RESEND_API_KEY) {
    console.log(`PASSWORD RESET CODE for ${email}: ${code}`);
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESET_EMAIL_FROM,
      to: email,
      subject: "Reset your GoalTracker Pro password",
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.5;">
          <h2>Reset your password</h2>
          <p>Your password reset code is:</p>
          <div style="font-size: 28px; font-weight: 800; letter-spacing: 6px;">
            ${code}
          </div>
          <p>This code expires in 10 minutes.</p>
          <p>If you did not request this, you can ignore this email.</p>
        </div>
      `,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to send reset email: ${text}`);
  }
};


const weekDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const normalizeGoalRoutineMode = (
  routineMode,
  selectedDays = [],
  goalEndDate = "",
) => {
  const mode = String(routineMode ?? "").trim().toLowerCase();
  const hasFiniteEndDate = String(goalEndDate ?? "").trim().length > 0;

 if (hasFiniteEndDate && selectedDays.length === 0) {
  return "custom";
}

  if (selectedDays.length > 0) {
    return selectedDays.length >= 7 ? "everyday" : "custom";
  }

  return mode === "everyday" || mode === "daily"
    ? "everyday"
    : "custom";
};

const normalizeGoalSelectedDays = (days = []) => {
  const validDays = new Set(weekDays);

  const normalized = (Array.isArray(days) ? days : [])
    .map((day) => String(day ?? "").trim())
    .filter((day) => validDays.has(day));

  return Array.from(new Set(normalized)).sort(
    (a, b) => weekDays.indexOf(a) - weekDays.indexOf(b),
  );
};

const inferGoalSelectedDaysFromPlan = (planItems = []) => {
  return normalizeGoalSelectedDays(
    planItems
      .filter((item) => String(item?.targetType ?? "weekday") === "weekday")
      .map((item) => item?.weekdayLabel),
  );
};

const normalizeGoalTimeValue = (value = "") => {
  const raw = String(value)
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, "");

  const match = raw.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm)?$/);

  if (!match) return "";

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3];

  if (minute < 0 || minute > 59) return "";
  if (meridiem && (hour < 1 || hour > 12)) return "";
  if (!meridiem && (hour < 0 || hour > 23)) return "";

  if (meridiem === "am" && hour === 12) hour = 0;
  if (meridiem === "pm" && hour !== 12) hour += 12;

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

const normalizeGoalSessionTimes = (
  sessionTimes = [],
  legacySessionTime = null,
) => {
  const source =
    Array.isArray(sessionTimes) && sessionTimes.length > 0
      ? sessionTimes
      : legacySessionTime
        ? [legacySessionTime]
        : [];

  return source
    .map((item) => ({
      startTime: normalizeGoalTimeValue(item?.startTime),
      endTime: normalizeGoalTimeValue(item?.endTime),
    }))
    .filter(
      (item) =>
        item.startTime &&
        item.endTime &&
        item.startTime !== item.endTime,
    )
    .slice(0, 4);
};

const addMinutesToTime = (timeValue = "", minutesToAdd = 60) => {
  const normalized = normalizeGoalTimeValue(timeValue);
  if (!normalized) return "";

  const [hour, minute] = normalized.split(":").map(Number);
  const total = hour * 60 + minute + minutesToAdd;
  return formatMinutesToTime(total);
};

const parseSessionDurationMinutesFromText = (text = "") => {
  const raw = String(text ?? "").toLowerCase();
  if (!raw) return 0;

  const hourMinuteMatch = raw.match(/\b(\d{1,2})\s*(?:h|hr|hrs|hour|hours)\s*(?:(\d{1,2})\s*(?:m|min|mins|minute|minutes))?\b/i);
  if (hourMinuteMatch) {
    const hours = Number(hourMinuteMatch[1] ?? 0);
    const minutes = Number(hourMinuteMatch[2] ?? 0);
    const total = hours * 60 + minutes;
    return total > 0 && total <= 240 ? total : 0;
  }

  const minuteMatch = raw.match(/\b(\d{1,3})\s*(?:m|min|mins|minute|minutes)\b/i);
  if (minuteMatch) {
    const minutes = Number(minuteMatch[1] ?? 0);
    return minutes > 0 && minutes <= 240 ? minutes : 0;
  }

  return 0;
};

const inferSingleSessionTimeFromText = (text = "") => {
  const raw = String(text ?? "").toLowerCase();
  const sessions = [];
  const seenStarts = new Set();
  let looseSource = raw;
  const addSession = (session) => {
    if (!session?.startTime || !session?.endTime || session.startTime === session.endTime) return;
    if (seenStarts.has(session.startTime)) return;
    seenStarts.add(session.startTime);
    sessions.push(session);
  };

  const rangePattern = /\b(\d{1,2})(?:[:\s]?(\d{2}))?\s*(am|pm)?\s*(?:-|to|till|until)\s*(\d{1,2})(?:[:\s]?(\d{2}))?\s*(am|pm)?\b/gi;
  for (const match of raw.matchAll(rangePattern)) {
    const startMeridiem = match[3] ?? match[6];
    const endMeridiem = match[6] ?? match[3];
    if (!startMeridiem || !endMeridiem) continue;

    const startTime = normalizeGoalTimeValue(`${match[1]}${match[2] ?? ""}${startMeridiem}`);
    const endTime = normalizeGoalTimeValue(`${match[4]}${match[5] ?? ""}${endMeridiem}`);
    addSession({ startTime, endTime });
    looseSource = looseSource.replace(match[0], " ");
  }

  const looseTimePattern = /\b(\d{1,2})(?:[:\s]?(\d{2}))?\s*(am|pm)\b/gi;
  for (const match of looseSource.matchAll(looseTimePattern)) {
    const startTime = normalizeGoalTimeValue(`${match[1]}${match[2] ?? ""}${match[3]}`);
    if (!startTime) continue;
    addSession({ startTime, endTime: addMinutesToTime(startTime, 60), inferredEndTime: true });
  }

  return sessions.slice(0, 4);
};

const inferSleepSessionTimesFromText = (text = "") => {
  const raw = String(text ?? "").toLowerCase();
  if (!/\b(sleep|sleeping|bedtime|bed time|bed|wake|waking|wake up)\b/.test(raw)) {
    return [];
  }

  const timeMatches = [...raw.matchAll(/\b(\d{1,2})(?:[:\s]?(\d{2}))?\s*(am|pm)\b/gi)]
    .map((match) => ({
      raw: match[0],
      index: match.index ?? 0,
      time: normalizeGoalTimeValue(`${match[1]}${match[2] ?? ""}${match[3]}`),
    }))
    .filter((item) => item.time);

  if (timeMatches.length === 0) return [];

  const classifyTime = (item) => {
    const before = raw.slice(Math.max(0, item.index - 36), item.index);
    const after = raw.slice(item.index + item.raw.length, item.index + item.raw.length + 36);
    const context = `${before} ${after}`;

    if (/\b(wake|waking|wake up|get up)\b/.test(context)) return "wake";
    if (/\b(sleep|sleeping|bedtime|bed time|bed)\b/.test(context)) return "bed";
    return "";
  };

  let bedTime = "";
  let wakeTime = "";
  for (const item of timeMatches) {
    const kind = classifyTime(item);
    if (kind === "bed" && !bedTime) bedTime = item.time;
    if (kind === "wake" && !wakeTime) wakeTime = item.time;
  }

  if (!bedTime && !wakeTime && timeMatches.length >= 2 && /\b(sleep|sleeping|bedtime|bed time|bed)\b/.test(raw) && /\b(wake|waking|wake up|get up)\b/.test(raw)) {
    bedTime = timeMatches[0].time;
    wakeTime = timeMatches[1].time;
  }

  const sessions = [];
  if (bedTime) {
    sessions.push({
      startTime: bedTime,
      endTime: addMinutesToTime(bedTime, 30),
      inferredEndTime: false,
      purpose: "bedtime",
    });
  }
  if (wakeTime) {
    sessions.push({
      startTime: wakeTime,
      endTime: addMinutesToTime(wakeTime, 15),
      inferredEndTime: false,
      purpose: "wake",
    });
  }

  return sessions.slice(0, 2);
};

const buildSessionTimeConfirmationReply = (sessionTimes = []) => {
  const sessions = Array.isArray(sessionTimes) ? sessionTimes.filter((session) => session?.startTime && session?.endTime) : [];
  const [session] = sessions;
  if (!session?.startTime || !session?.endTime) return "What time should we use for it?";

  if (sessions.length > 1) {
    const starts = sessions.map((item) => formatGoalTimeForUser(item.startTime)).join(", ");
    const proposed = sessions
      .map((item) => `${formatGoalTimeForUser(item.startTime)} to ${formatGoalTimeForUser(item.endTime)}`)
      .join(", ");
    return `I have these times: ${starts}. Should I make each session 1 hour, like ${proposed}?`;
  }

  return `I will use ${formatGoalTimeForUser(session.startTime)}. For this kind of session, I suggest ${formatGoalTimeForUser(session.startTime)} to ${formatGoalTimeForUser(session.endTime)}. Does that work?`;
};

const inferStartDateFromText = (text = "", now = new Date()) => {
  const raw = String(text ?? "").trim().toLowerCase();
  if (!raw) return "";

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  if (/\b(today|tonight|start now|immediately)\b/.test(raw)) {
    return formatLocalDateISO(today);
  }

  if (/\b(tomorrow)\b/.test(raw)) {
    return formatLocalDateISO(addDays(today, 1));
  }

  const weekdayMatch = raw.match(/\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:\s+next\s+week)?\b/i);
  if (weekdayMatch) {
    const weekdayAliases = {
      monday: "Mon", mon: "Mon",
      tuesday: "Tue", tue: "Tue", tues: "Tue",
      wednesday: "Wed", wed: "Wed",
      thursday: "Thu", thu: "Thu", thur: "Thu", thurs: "Thu",
      friday: "Fri", fri: "Fri",
      saturday: "Sat", sat: "Sat",
      sunday: "Sun", sun: "Sun",
    };
    const targetDay = weekdayAliases[weekdayMatch[2]];
    const forceNextWeek = Boolean(weekdayMatch[1]) || /\bnext\s+week\b/.test(raw);

    for (let offset = forceNextWeek ? 1 : 0; offset <= 14; offset += 1) {
      const candidate = addDays(today, offset);
      if (getWeekdayLabelForDate(candidate) !== targetDay) continue;
      if (offset === 0) continue;
      return formatLocalDateISO(candidate);
    }
  }

  const dayOnlyMatch = raw.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (dayOnlyMatch && /\b(date|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|start)\b/.test(raw)) {
    const day = Number(dayOnlyMatch[1]);
    if (day >= 1 && day <= 31) {
      for (let monthOffset = 0; monthOffset <= 1; monthOffset += 1) {
        const candidate = new Date(today.getFullYear(), today.getMonth() + monthOffset, day);
        candidate.setHours(0, 0, 0, 0);
        if (candidate.getMonth() !== today.getMonth() + monthOffset) continue;
        if (candidate >= today) return formatLocalDateISO(candidate);
      }
    }
  }

  return "";
};
const hasMeaningfulTextValue = (value) => {
  return String(value ?? "").trim().length > 0;
};

const isPlainObject = (value) => {
  return value && typeof value === "object" && !Array.isArray(value);
};

const isMeaningfulStructuredValue = (value) => {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
};

const mergeStructuredObjects = (currentValue = {}, incomingValue = {}) => {
  const current = isPlainObject(currentValue) ? currentValue : {};
  const incoming = isPlainObject(incomingValue) ? incomingValue : {};
  const merged = { ...current };

  Object.entries(incoming).forEach(([key, value]) => {
    if (!isMeaningfulStructuredValue(value)) return;

    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeStructuredObjects(merged[key], value);
      return;
    }

    merged[key] = value;
  });

  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => isMeaningfulStructuredValue(value)),
  );
};

const mergeKnownFacts = mergeStructuredObjects;

const normalizeCalendarExceptions = (exceptions = []) => {
  if (!Array.isArray(exceptions)) return [];

  return exceptions
    .map((exception, index) => ({
      id:
        String(exception?.id ?? "").trim() ||
        `calendar-exception-${Date.now()}-${index}-${Math.random()
          .toString(36)
          .slice(2, 9)}`,
      action: "skip",
      targetType: String(exception?.targetType ?? "").trim(),
      plannedDate: exception?.plannedDate
        ? String(exception.plannedDate).trim()
        : undefined,
      targetKey: exception?.targetKey
        ? String(exception.targetKey).trim()
        : undefined,
      shiftId: exception?.shiftId
        ? String(exception.shiftId).trim()
        : undefined,
      applyToAllShifts: Boolean(exception?.applyToAllShifts),
    }))
    .filter((exception) => {
      if (exception.targetType === "date") {
        return Boolean(exception.plannedDate);
      }

      return (
        ["week", "month", "year"].includes(exception.targetType) &&
        Boolean(exception.targetKey)
      );
    });
};

const normalizeGoalPlanningType = (value = "") => {
  const type = String(value ?? "").trim().toLowerCase();

  return type === "outcome" || type === "routine" || type === "one_time"
    ? type
    : "";
};

const mergeCalendarExceptions = (...sources) => {
  const normalized = normalizeCalendarExceptions(sources.flat());
  const seen = new Set();

  return normalized.filter((exception) => {
    const key = [
      exception.targetType,
      exception.plannedDate ?? "",
      exception.targetKey ?? "",
      exception.shiftId ?? "",
      exception.applyToAllShifts ? "all" : "one",
    ].join("|");

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const GENERIC_GOAL_TITLES = new Set([
  "my life",
  "life",
  "this goal",
  "goal",
  "routine",
  "routine plan",
  "success plan",
  "performance upgrade",
  "yo",
  "hi",
  "hey",
  "hello",
  "howfar",
  "how far",
  "how far now",
  "how u dey",
  "how you dey",
  "how dey",
  "how now",
  "wetin dey",
  "how body",
  "what's up",
  "whats up",
  "sup",
]);

const isGenericGoalTitle = (value = "") => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");

  const greetingLike =
    /^(hi|hey|hello|yo|sup|howfar|how far|how far now|how u dey|how you dey|how dey|how now|wetin dey|how body|what'?s up|whats up)(\s+(bro|boss|henry|there|now))?$/i.test(
      normalized,
    );

  return !normalized || GENERIC_GOAL_TITLES.has(normalized) || greetingLike;
};

const cleanGoalTitleCandidate = (value = "") => {
  const original = String(value ?? "")
    .trim()
    .replace(/^i\s+(want|need|would like|am trying)\s+to\s+/i, "")
    .replace(/^i\s+want\s+/i, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  const normalized = original.toLowerCase();

  if (/\b(jamb)\b/.test(normalized) && /\b(300\+|300 plus|score 300|get 300)\b/.test(normalized)) {
    return "JAMB 300+ Plan";
  }

  if (/^how\s+(do|can)\s+i\s+/i.test(original)) {
    return original
      .replace(/^how\s+(do|can)\s+i\s+/i, "")
      .replace(/^(get|become|build|make|start|improve|learn|pass)\s+/i, "")
      .replace(/\b(in|my)\s+/i, "")
      .replace(/\?+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^./, (letter) => letter.toUpperCase())
      .slice(0, 80);
  }

  return original;
};

const getBestGoalTitle = (goalMeta = null, fallbackGoal = "") => {
  const knownFacts = isPlainObject(goalMeta?.knownFacts) ? goalMeta.knownFacts : {};
  const candidates = [
    goalMeta?.goalTitle,
    knownFacts.successTarget,
    knownFacts.direction,
    goalMeta?.coreProblem,
    fallbackGoal,
  ];

  for (const candidate of candidates) {
    const cleaned = cleanGoalTitleCandidate(candidate);
    if (cleaned && !isGenericGoalTitle(cleaned)) return cleaned;
  }

  return cleanGoalTitleCandidate(fallbackGoal) || "This Goal";
};
const normalizeMemoryText = (value = "", maxWords = 70, maxChars = 520) => {
  const words = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, maxWords);

  return words.join(" ").slice(0, maxChars).trim();
};

const normalizeMemoryList = (value = [], maxItems = 8) => {
  const source = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const result = [];

  for (const item of source) {
    const cleaned = normalizeMemoryText(item, 18, 160);
    const key = normalizeCoachTextForComparison(cleaned);

    if (!cleaned || seen.has(key)) continue;

    seen.add(key);
    result.push(cleaned);

    if (result.length >= maxItems) break;
  }

  return result;
};

const normalizeGoalForm = ({
  goalMeta = null,
  fallbackGoal = "",
  fallbackPlan = [],
  fallbackStartDate = "",
  fallbackEndDate = "",
}) => {
  const selectedDaysFromMeta = normalizeGoalSelectedDays(
    goalMeta?.selectedDays,
  );

  const selectedDays =
    selectedDaysFromMeta.length > 0
      ? selectedDaysFromMeta
      : inferGoalSelectedDaysFromPlan(fallbackPlan);

const sessionTimes = normalizeGoalSessionTimes(
  goalMeta?.sessionTimes,
  goalMeta?.sessionTime,
);

const sessionTime = sessionTimes[0] ?? {
  startTime: "",
  endTime: "",
};

const hasGoalEndDate = String(
  goalMeta?.goalEndDate ?? fallbackEndDate ?? "",
).trim().length > 0;
const hasEstimatedDuration =
  Number(goalMeta?.estimatedDurationDays ?? 0) > 0 ||
  String(goalMeta?.estimatedDurationLabel ?? "").trim().length > 0;

return {
  goalTitle: getBestGoalTitle(goalMeta, fallbackGoal),
    goalPlanningType: normalizeGoalPlanningType(goalMeta?.goalPlanningType),
  userIntent: String(goalMeta?.userIntent ?? "").trim(),
  coreProblem: String(goalMeta?.coreProblem ?? "").trim(),
  suggestedSolution: String(goalMeta?.suggestedSolution ?? "").trim(),
  solutionAccepted: Boolean(goalMeta?.solutionAccepted),
  knownFacts: isPlainObject(goalMeta?.knownFacts) ? goalMeta.knownFacts : {},
  goalParts: isPlainObject(goalMeta?.goalParts) ? goalMeta.goalParts : {},
  pendingSuggestion: isPlainObject(goalMeta?.pendingSuggestion)
    ? goalMeta.pendingSuggestion
    : {},
  responseMode: normalizeResponseMode(goalMeta?.responseMode),
  shouldBuildGoalCard: Boolean(goalMeta?.shouldBuildGoalCard),
  memorySummary: normalizeMemoryText(goalMeta?.memorySummary),
  lockedDecisions: normalizeMemoryList(goalMeta?.lockedDecisions, 8),
  openQuestions: normalizeMemoryList(goalMeta?.openQuestions, 3),
  lastQuestionType: normalizeMemoryText(goalMeta?.lastQuestionType, 6, 80),
  lastQuestionWasFinal: Boolean(goalMeta?.lastQuestionWasFinal),
  existingBusyTimes: Array.isArray(goalMeta?.existingBusyTimes)
    ? goalMeta.existingBusyTimes
    : [],
  finalSummaryOffered: Boolean(goalMeta?.finalSummaryOffered),
  finalSummaryConfirmed: Boolean(goalMeta?.finalSummaryConfirmed),
  recommendedStructure: String(goalMeta?.recommendedStructure ?? "").trim(),
  structureSuggested: Boolean(goalMeta?.structureSuggested),
  structureAccepted: Boolean(goalMeta?.structureAccepted),
  levelProgression: String(goalMeta?.levelProgression ?? "").trim(),
  routineMode: normalizeGoalRoutineMode(
    goalMeta?.routineMode,
    selectedDays,
    goalMeta?.goalEndDate ?? fallbackEndDate,
  ),
  selectedDays,
  breakDays: normalizeGoalSelectedDays(goalMeta?.breakDays),
  breaksNeeded: Boolean(goalMeta?.breaksNeeded),
  levelNeeded: Boolean(goalMeta?.levelNeeded),
  level: String(goalMeta?.level ?? "").trim().toLowerCase(),
  sessionTime,
  sessionTimes,
  goalUnderstandingComplete: Boolean(goalMeta?.goalUnderstandingComplete),
  breaksResolved: Boolean(goalMeta?.breaksResolved),
  levelResolved: Boolean(goalMeta?.levelResolved),
  goalStartDate: String(
    goalMeta?.goalStartDate ?? fallbackStartDate ?? "",
  ).trim(),
  goalEndDate: String(goalMeta?.goalEndDate ?? fallbackEndDate ?? "").trim(),
  estimatedDurationDays: Number(goalMeta?.estimatedDurationDays ?? 0),
  estimatedDurationLabel: String(
    goalMeta?.estimatedDurationLabel ?? "",
  ).trim(),
durationResolved:
  Boolean(goalMeta?.durationResolved) ||
  hasGoalEndDate ||
  hasEstimatedDuration,
  currentPhaseLabel: String(goalMeta?.currentPhaseLabel ?? "").trim(),
    calendarExceptions: normalizeCalendarExceptions(
    goalMeta?.calendarExceptions,
  ),
};
};

const addDays = (date, days) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const formatLocalDateISO = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
};

const formatLocalDateTimeContext = (date = new Date()) => {
  const weekday = weekDays[(date.getDay() + 6) % 7];
  const hour = date.getHours();
  const minute = String(date.getMinutes()).padStart(2, "0");
  const hour12 = hour % 12 || 12;
  const suffix = hour >= 12 ? "pm" : "am";

  return {
    dateISO: formatLocalDateISO(date),
    weekday,
    time24: `${String(hour).padStart(2, "0")}:${minute}`,
    timeLabel: `${hour12}:${minute}${suffix}`,
    minutes: hour * 60 + date.getMinutes(),
  };
};

const getWeekdayLabelForDate = (date = new Date()) => {
  return weekDays[(date.getDay() + 6) % 7];
};

const getOrdinalDay = (day) => {
  const suffix =
    day % 10 === 1 && day % 100 !== 11
      ? "st"
      : day % 10 === 2 && day % 100 !== 12
        ? "nd"
        : day % 10 === 3 && day % 100 !== 13
          ? "rd"
          : "th";

  return `${day}${suffix}`;
};

const formatFriendlyDate = (date = new Date()) => {
  return `${getOrdinalDay(date.getDate())}, ${date.toLocaleDateString("en-NG", {
    month: "long",
  })} ${date.getFullYear()}`;
};

const formatGoalDateForUser = (value = "") => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return raw;

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return raw;

  return formatFriendlyDate(date);
};

const resolveGoalStartDateRecommendation = (goalDraft = {}, now = new Date()) => {
  const selectedDays = normalizeGoalSelectedDays(goalDraft?.selectedDays);
  const sessionTimes = normalizeGoalSessionTimes(
    goalDraft?.sessionTimes,
    goalDraft?.sessionTime,
  );

  if (selectedDays.length === 0 || sessionTimes.length === 0) return null;

  const firstSession = sessionTimes[0];
  const startMinutes = parseTimeToMinutes(firstSession.startTime);
  if (!Number.isFinite(startMinutes)) return null;

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayLabel = getWeekdayLabelForDate(today);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todayIsSelected = selectedDays.includes(todayLabel);
  const todayTimeHasPassed = todayIsSelected && startMinutes <= nowMinutes;

  for (let offset = 0; offset <= 21; offset += 1) {
    const candidate = addDays(today, offset);
    const candidateDay = getWeekdayLabelForDate(candidate);

    if (!selectedDays.includes(candidateDay)) continue;
    if (offset === 0 && startMinutes <= nowMinutes) continue;

    return {
      dateISO: formatLocalDateISO(candidate),
      dayLabel: candidateDay,
      friendlyDate: formatFriendlyDate(candidate),
      startTime: firstSession.startTime,
      startTimeText: formatGoalTimeForUser(firstSession.startTime),
      todayIsSelected,
      todayTimeHasPassed,
      isToday: offset === 0,
    };
  }

  return null;
};

const buildGoalStartDateReply = (goalDraft = {}, now = new Date()) => {
  const recommendation = resolveGoalStartDateRecommendation(goalDraft, now);

  if (!recommendation) {
    return "When should this plan start?";
  }

  if (recommendation.isToday) {
    return `This can start today at ${recommendation.startTimeText}. Should I use today as the start date?`;
  }

  if (recommendation.todayTimeHasPassed) {
    return `${recommendation.startTimeText} has already passed today, so I would start this on ${recommendation.friendlyDate}. Is that okay?`;
  }

  return `The first matching day is ${recommendation.friendlyDate} at ${recommendation.startTimeText}. Should I start it then?`;
};

const getLockedGoalDraftFields = (goalDraft = {}) => {
  const locks = [];

  if (normalizeGoalPlanningType(goalDraft?.goalPlanningType)) locks.push("goalPlanningType");
  if (normalizeGoalSelectedDays(goalDraft?.selectedDays).length > 0) locks.push("selectedDays");
  if (normalizeGoalSessionTimes(goalDraft?.sessionTimes, goalDraft?.sessionTime).length > 0) locks.push("sessionTimes");
  if (String(goalDraft?.goalStartDate ?? "").trim()) locks.push("goalStartDate");
  if (String(goalDraft?.goalEndDate ?? "").trim()) locks.push("goalEndDate");
  if (
    Number(goalDraft?.estimatedDurationDays ?? 0) > 0 ||
    String(goalDraft?.estimatedDurationLabel ?? "").trim()
  ) {
    locks.push("estimatedDuration");
  }
  if (String(goalDraft?.level ?? "").trim() || goalDraft?.levelResolved) locks.push("level");
  if (goalDraft?.breaksResolved || normalizeGoalSelectedDays(goalDraft?.breakDays).length > 0) locks.push("breaks");

  return locks;
};

const paystackRequest = async (path, options = {}) => {
  if (!PAYSTACK_SECRET_KEY) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured");
  }

  const response = await fetch(`https://api.paystack.co${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await response.json();

  if (!response.ok || data.status === false) {
    throw new Error(data?.message || "Paystack request failed");
  }

  return data;
};

const requireBillingConfig = () => {
  if (!supabaseAdmin) {
    throw new Error("Supabase service role is not configured");
  }

  if (!PAYSTACK_SECRET_KEY) {
    throw new Error("Paystack secret key is not configured");
  }
};


// ================= CREDIT SYSTEM =================

// TEMP in-memory storage. Move this to Supabase before production.
const UNLIMITED_CREDIT_BALANCE = 999999;
const parseEnvList = (value = "") =>
  String(value)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
const unlimitedCreditUserIds = new Set(
  parseEnvList(process.env.UNLIMITED_CREDIT_USER_IDS),
);
const unlimitedCreditEmails = new Set(
  parseEnvList(process.env.UNLIMITED_CREDIT_EMAILS),
);
const isUnlimitedCreditUser = (userId = "", email = "") => {
  const normalizedUserId = String(userId ?? "").trim().toLowerCase();
  const normalizedEmail = String(email ?? "").trim().toLowerCase();

  return (
    unlimitedCreditUserIds.has(normalizedUserId) ||
    (normalizedEmail && unlimitedCreditEmails.has(normalizedEmail))
  );
};
const userCredits = new Map();

const BILLING_PLANS = {
  mini: {
    id: "mini",
    name: "Mini Plan",
    baseAmount: 700,
    credits: 50,
    paystackPlanCode: PAYSTACK_MINI_PLAN_CODE,
  },
  standard: {
    id: "standard",
    name: "Standard Plan",
    baseAmount: 1800,
    credits: 150,
    paystackPlanCode: PAYSTACK_STANDARD_PLAN_CODE,
  },
  premium: {
    id: "premium",
    name: "Premium Plan",
    baseAmount: 2800,
    credits: 250,
    paystackPlanCode: PAYSTACK_PREMIUM_PLAN_CODE,
  },
};

const CREDIT_PACKS = {
  credits_50: {
    id: "credits_50",
    name: "50 Goach Credits",
    baseAmount: 700,
    credits: 50,
  },
  credits_150: {
    id: "credits_150",
    name: "150 Goach Credits",
    baseAmount: 1800,
    credits: 150,
  },
  credits_250: {
    id: "credits_250",
    name: "250 Goach Credits",
    baseAmount: 2800,
    credits: 250,
  },
};
const CREDIT_RULES = {
  free: {
    initialCredits: 0,
    monthlyRefill: 0,
    maxCredits: 0,
  },
  trial: {
    initialCredits: 50,
    monthlyRefill: 0,
    maxCredits: 50,
  },
  mini: {
    initialCredits: 50,
    monthlyRefill: 50,
    maxCredits: 50,
  },
  standard: {
    initialCredits: 150,
    monthlyRefill: 150,
    maxCredits: 150,
  },
  premium: {
    initialCredits: 250,
    monthlyRefill: 250,
    maxCredits: 250,
  },
};

const getBillingPlan = (planId = "") => {
  const key = String(planId || "").trim().toLowerCase();
  return BILLING_PLANS[key] ?? null;
};

const getCreditPack = (packId = "") => {
  const key = String(packId || "").trim().toLowerCase();
  return CREDIT_PACKS[key] ?? null;
};

const getCreditPackFromPaystackData = (data = {}) => {
  const metadata = data.metadata || data.transaction?.metadata || {};
  return getCreditPack(metadata.packId);
};

const isActivePaidProfile = (profile = {}) => {
  return (
    ["mini", "standard", "premium"].includes(profile.plan) &&
    profile.subscription_status === "active"
  );
};

const getBillingPlanByPaystackCode = (planCode = "") => {
  const code = String(planCode || "").trim();
  if (!code) return null;

  return (
    Object.values(BILLING_PLANS).find(
      (plan) => String(plan.paystackPlanCode || "").trim() === code,
    ) ?? null
  );
};

const getPaystackEventReference = (data = {}) => {
  return (
    data.reference ||
    data.transaction?.reference ||
    data.payment_reference ||
    data.invoice_code ||
    data.id ||
    null
  );
};

const getBillingPlanFromPaystackData = (data = {}) => {
  const metadata = data.metadata || data.transaction?.metadata || {};
  const metadataPlan = getBillingPlan(metadata.planId);
  if (metadataPlan) return metadataPlan;

  const planCode =
    data.plan?.plan_code ||
    data.plan?.id ||
    data.subscription?.plan?.plan_code ||
    data.transaction?.plan?.plan_code ||
    data.transaction?.plan?.id;

  return getBillingPlanByPaystackCode(planCode);
};

const getPaystackProfileQuery = async (data = {}) => {
  const metadata = data.metadata || data.transaction?.metadata || {};
  const userId = metadata.userId || data.userId || data.customer?.metadata?.userId;

  if (userId) {
    return supabaseAdmin
      .from("profiles")
      .select("id, ai_credits, payment_reference, customer_id, subscription_id")
      .eq("id", userId)
      .single();
  }

  const customerCode =
    data.customer?.customer_code ||
    data.customer_code ||
    data.transaction?.customer?.customer_code;

  if (customerCode) {
    return supabaseAdmin
      .from("profiles")
      .select("id, ai_credits, payment_reference, customer_id, subscription_id")
      .eq("customer_id", customerCode)
      .maybeSingle();
  }

  return { data: null, error: new Error("Paystack event has no user or customer reference") };
};

const disablePaystackSubscriptionByCode = async (code, token) => {
  if (!code || !token) return { disabled: false, reason: "missing_code_or_token" };

  await paystackRequest("/subscription/disable", {
    method: "POST",
    body: JSON.stringify({ code, token }),
  });

  return { disabled: true };
};

const verifyPaystackWebhookSignature = (req) => {
  const signature = String(req.headers["x-paystack-signature"] || "");
  if (!PAYSTACK_SECRET_KEY || !signature || !req.rawBody) return false;

  const expected = createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(req.rawBody)
    .digest("hex");

  const signatureBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  return (
    signatureBuffer.length === expectedBuffer.length &&
    timingSafeEqual(signatureBuffer, expectedBuffer)
  );
};

const applyPaystackPlanPayment = async (data = {}) => {
  if (!supabaseAdmin) {
    throw new Error("Supabase service role is not configured");
  }

  const billingPlan = getBillingPlanFromPaystackData(data);
  const reference = getPaystackEventReference(data);

  if (!billingPlan || !reference) {
    return { applied: false, reason: "missing_plan_or_reference" };
  }

  const { data: profile, error: profileError } = await getPaystackProfileQuery(data);

  if (profileError || !profile) {
    return { applied: false, reason: "profile_not_found" };
  }

  if (profile.payment_reference === reference) {
    return { applied: false, reason: "already_applied" };
  }

  const now = new Date();
  const currentPeriodEndsAt = addDays(now, 30);
  const existingCredits = Number(profile.ai_credits ?? 0);
  const nextCredits = Math.max(0, existingCredits) + billingPlan.credits;
  const customerCode =
    data.customer?.customer_code ||
    data.customer_code ||
    data.transaction?.customer?.customer_code ||
    profile.customer_id ||
    null;
  const subscriptionCode =
    data.subscription?.subscription_code ||
    data.subscription_code ||
    data.transaction?.subscription?.subscription_code ||
    profile.subscription_id ||
    null;
  const authorizationCode =
    data.authorization?.authorization_code ||
    data.transaction?.authorization?.authorization_code ||
    null;
  const billingEmail =
    data.customer?.email ||
    data.transaction?.customer?.email ||
    null;

  const { error: updateError } = await supabaseAdmin
    .from("profiles")
    .update({
      plan: billingPlan.id,
      ai_credits: nextCredits,
      trial_used: true,
      trial_started_at: null,
      trial_ends_at: null,
      subscription_status: "active",
      subscription_provider: "paystack",
      subscription_id: subscriptionCode,
      customer_id: customerCode,
      payment_authorization_code: authorizationCode,
      payment_reference: reference,
      billing_email: billingEmail,
      cancel_at_period_end: false,
      current_period_ends_at: currentPeriodEndsAt.toISOString(),
      pending_plan: null,
      pending_plan_starts_at: null,
    })
    .eq("id", profile.id);

  if (updateError) throw updateError;

  const creditUser = await getOrCreateCreditUser(profile.id, billingPlan.id);
  creditUser.credits = nextCredits;
  creditUser.plan = billingPlan.id;

  return {
    applied: true,
    userId: profile.id,
    plan: billingPlan.id,
    remainingCredits: nextCredits,
  };
};

const applyPaystackCreditPackPayment = async (data = {}) => {
  if (!supabaseAdmin) {
    throw new Error("Supabase service role is not configured");
  }

  const creditPack = getCreditPackFromPaystackData(data);
  const reference = getPaystackEventReference(data);
  const metadata = data.metadata || data.transaction?.metadata || {};
  const userId = metadata.userId;

  if (!creditPack || !reference || !userId) {
    return { applied: false, reason: "missing_pack_reference_or_user" };
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("id, plan, subscription_status, ai_credits, payment_reference")
    .eq("id", userId)
    .single();

  if (profileError || !profile) {
    return { applied: false, reason: "profile_not_found" };
  }

  if (!isActivePaidProfile(profile)) {
    return { applied: false, reason: "paid_plan_required" };
  }

  if (profile.payment_reference === reference) {
    return { applied: false, reason: "already_applied" };
  }

  const existingCredits = Number(profile.ai_credits ?? 0);
  const nextCredits = Math.max(0, existingCredits) + creditPack.credits;
  const billingEmail = data.customer?.email || data.transaction?.customer?.email || null;

  const { error: updateError } = await supabaseAdmin
    .from("profiles")
    .update({
      ai_credits: nextCredits,
      payment_reference: reference,
      billing_email: billingEmail,
    })
    .eq("id", profile.id);

  if (updateError) throw updateError;

  const creditUser = await getOrCreateCreditUser(profile.id, profile.plan);
  creditUser.credits = nextCredits;
  creditUser.plan = profile.plan;

  return {
    applied: true,
    userId: profile.id,
    pack: creditPack.id,
    addedCredits: creditPack.credits,
    remainingCredits: nextCredits,
  };
};

const disablePaystackSubscription = async (data = {}) => {
  if (!supabaseAdmin) {
    throw new Error("Supabase service role is not configured");
  }

  const subscriptionCode = data.subscription_code || data.subscription?.subscription_code;
  const customerCode = data.customer?.customer_code || data.customer_code;

  let query = supabaseAdmin.from("profiles").update({
    subscription_status: "inactive",
    cancel_at_period_end: false,
  });

  if (subscriptionCode) {
    query = query.eq("subscription_id", subscriptionCode);
  } else if (customerCode) {
    query = query.eq("customer_id", customerCode);
  } else {
    return { applied: false, reason: "missing_subscription_or_customer" };
  }

  const { error } = await query;
  if (error) throw error;

  return { applied: true };
};

const getNormalizedPlan = (plan = "free", subscriptionStatus = "") => {
  if (["mini", "standard", "premium"].includes(plan)) return plan;
  if (subscriptionStatus === "trialing") return "trial";
  return "free";
};


const getCost = (path) => {
  if (path.includes("generate-plan")) return 5;
  if (path.includes("modify-plan")) return 3;
  if (path.includes("generate-summary")) return 2;
  return 1;
};

const isNewMonth = (lastRefillAt) => {
  if (!lastRefillAt) return false;

  const last = new Date(lastRefillAt);
  const now = new Date();

  return (
    last.getFullYear() !== now.getFullYear() ||
    last.getMonth() !== now.getMonth()
  );
};

const getOrCreateCreditUser = async (userId, planFromRequest = "free") => {
  if (!userId) {
    throw new Error("User ID required");
  }

  if (supabaseAdmin) {
    const { data: profile, error } = await supabaseAdmin
      .from("profiles")
      .select("id, plan, ai_credits, subscription_status")
      .eq("id", userId)
      .single();

    if (error || !profile) {
      throw new Error("Profile not found");
    }

    const plan = getNormalizedPlan(
      profile.plan || planFromRequest,
      profile.subscription_status,
    );

    const rules = CREDIT_RULES[plan] ?? CREDIT_RULES.free;

    let credits = Number(profile.ai_credits ?? 0);

    if (plan !== "free" && credits <= 0 && profile.ai_credits == null) {
      credits = rules.initialCredits;
    }

    if (plan === "free") {
      credits = 0;
    }

    const user = {
      credits,
      plan,
      lastRefillAt: new Date().toISOString(),
      usingSupabase: true,
    };

    userCredits.set(userId, user);
    return user;
  }

  const plan = getNormalizedPlan(planFromRequest);
  const rules = CREDIT_RULES[plan];

  let user = userCredits.get(userId);

  if (!user) {
    user = {
      credits: rules.initialCredits,
      plan,
      lastRefillAt: new Date().toISOString(),
      usingSupabase: false,
    };

    userCredits.set(userId, user);
    return user;
  }

  if (user.plan !== plan) {
    user.plan = plan;

    if (plan === "free") user.credits = 0;
    if (plan !== "free") {
      user.credits = Math.max(
        user.credits,
        CREDIT_RULES[plan]?.initialCredits ?? 0,
      );
    }
  }

  return user;
};


const checkCredits = async (req, res, next) => {
  const userId = req.headers["x-user-id"];
  const userPlan = req.headers["x-user-plan"] || "free";
  const userEmail = req.headers["x-user-email"] || req.headers["x-email"] || "";

  if (!userId) {
    return res.status(401).json({ error: "User ID required" });
  }

  if (isUnlimitedCreditUser(userId, userEmail)) {
    req.userId = userId;
    req.creditUser = {
      credits: UNLIMITED_CREDIT_BALANCE,
      plan: "tester",
      lastRefillAt: new Date().toISOString(),
      usingSupabase: false,
      unlimitedCredits: true,
    };
    req.creditCost = 0;
    return next();
  }

  let user;

try {
  user = await getOrCreateCreditUser(userId, userPlan);
} catch (error) {
  return res.status(403).json({
    error: error?.message || "Failed to load AI credits",
    upgrade: true,
    remainingCredits: 0,
    requiredCredits: getCost(req.path),
    plan: "free",
  });
}

const cost = getCost(req.path);


  if (user.plan === "free") {
    return res.status(403).json({
      error: "Goach requires a paid plan",
      upgrade: true,
      remainingCredits: 0,
      requiredCredits: cost,
      plan: user.plan,
    });
  }

  if (user.credits < cost) {
    return res.status(403).json({
      error: "Not enough AI credits",
      upgrade: user.plan === "free" || user.plan === "trial",
      remainingCredits: user.credits,
      requiredCredits: cost,
      plan: user.plan,
    });
  }

  req.userId = userId;
  req.creditUser = user;
  req.creditCost = cost;

  next();
};

const deductCreditsAfterSuccess = async (req) => {
  if (req.creditUser?.unlimitedCredits) {
    return UNLIMITED_CREDIT_BALANCE;
  }

  const remainingCredits = Math.max(
    0,
    req.creditUser.credits - req.creditCost,
  );

  req.creditUser.credits = remainingCredits;

  if (supabaseAdmin && req.userId) {
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({
        ai_credits: remainingCredits,
      })
      .eq("id", req.userId);

    if (error) {
      throw error;
    }
  }

  return remainingCredits;
};


// =================================================


const formatExistingScheduleForAI = (existingSchedule = []) => {
  if (!Array.isArray(existingSchedule) || existingSchedule.length === 0) {
    return "No existing schedule.";
  }

  return existingSchedule
    .map((goal) => {
      const goalTitle = String(goal.goalTitle ?? "Untitled goal").trim();
      const goalDays = Array.isArray(goal.days)
        ? goal.days.join(", ")
        : String(goal.days ?? "").trim();
      const dateRange = [goal.startDate, goal.endDate]
        .filter(Boolean)
        .join(" to ");
      const shifts = (goal.shifts || [])
        .map((s) => {
          const target = s.weekdayLabel || s.plannedDate || s.targetLabel || "unknown day";
          const label = s.title || s.explanation || "Existing shift";
          return `- ${target}: ${s.startTime}-${s.endTime} (${label})`;
        })
        .join("\n");

      return `Goal card: ${goalTitle}\nDays: ${goalDays || "not specified"}\nDates: ${dateRange || "not specified"}\nShifts:\n${shifts || "- No shifts"}`;
    })
    .join("\n\n");
};
const buildFreeTimeSuggestionsForAI = (existingSchedule = []) => {
  const busyByDay = {};

  if (!Array.isArray(existingSchedule)) return "No busy schedule found.";

  existingSchedule.forEach((goal) => {
    (goal.shifts || []).forEach((shift) => {
      const day =
        shift.weekdayLabel ||
        shift.plannedDate ||
        shift.targetLabel ||
        "Unknown";

      if (!busyByDay[day]) busyByDay[day] = [];

      busyByDay[day].push({
        goalTitle: goal.goalTitle || "Untitled goal",
      title: shift.title || goal.goalTitle || "Existing shift",
      startTime: shift.startTime,
        endTime: shift.endTime,
      });
    });
  });

  const suggestionWindows = [
    ["06:00", "07:00"],
    ["07:30", "08:30"],
    ["09:00", "10:00"],
    ["12:00", "13:00"],
    ["15:00", "16:00"],
    ["17:00", "18:00"],
    ["18:30", "19:30"],
    ["20:00", "21:00"],
  ];

  const lines = Object.entries(busyByDay).map(([day, busyShifts]) => {
    const free = suggestionWindows.filter(([start, end]) => {
      const startMin = parseTimeToMinutes(start);
      const endMin = parseTimeToMinutes(end);

      return !busyShifts.some((busy) =>
        areTimeRangesOverlapping(
          startMin,
          endMin,
          parseTimeToMinutes(busy.startTime),
          parseTimeToMinutes(busy.endTime),
        ),
      );
    });

    return `${day}: Suggested free slots: ${free.length
      ? free.map(([start, end]) => `${start}-${end}`).join(", ")
      : "No clear free slot from default windows"
      }`;
  });

  return lines.length ? lines.join("\n") : "No existing busy days found.";
};

/* ----------------------------- TIME HELPERS ----------------------------- */

const getCurrentWeekdayLabel = (date = new Date()) => {
  const jsDay = date.getDay();
  return weekDays[(jsDay + 6) % 7];
};

const parseTimeToMinutes = (timeString = "18:00") => {
  const [hour, minute] = String(timeString).split(":").map(Number);
  return (hour || 0) * 60 + (minute || 0);
};

const formatMinutesToTime = (totalMinutes) => {
  const safe = Math.max(0, Math.min(totalMinutes, 23 * 60 + 59));
  const hour = Math.floor(safe / 60);
  const minute = safe % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

const formatGoalTimeForUser = (timeValue = "") => {
  const normalized = normalizeGoalTimeValue(timeValue);
  if (!normalized) return "";

  const [hourValue, minuteValue] = normalized.split(":").map(Number);
  const suffix = hourValue >= 12 ? "pm" : "am";
  const hour12 = hourValue % 12 || 12;

  return `${hour12}:${String(minuteValue).padStart(2, "0")}${suffix}`;
};

const formatGoalPartValueForUser = (value) => {
  if (!isMeaningfulStructuredValue(value)) return "";

  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => formatGoalPartValueForUser(item))
      .filter(Boolean)
      .join(", ");
  }

  if (isPlainObject(value)) {
    return Object.entries(value)
      .map(([key, item]) => {
        const itemText = formatGoalPartValueForUser(item);
        if (!itemText) return "";
        return `${key}: ${itemText}`;
      })
      .filter(Boolean)
      .join(", ");
  }

  return "";
};

const formatGoalDaysForUser = (days = []) => {
  const normalizedDays = normalizeGoalSelectedDays(days);
  if (normalizedDays.length === 0) return "";
  if (normalizedDays.length >= 7) return "every day";
  if (normalizedDays.length === 1) return `every ${normalizedDays[0]}`;
  return `every ${normalizedDays.join(", ")}`;
};
const normalizeCoachTextForComparison = (value = "") =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();

const getLatestMessageByRole = (messages = [], role = "user") => {
  if (!Array.isArray(messages)) return "";

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(messages[index]?.role ?? "") === role) {
      return String(messages[index]?.content ?? "").trim();
    }
  }

  return "";
};

const isDirectClarificationQuestion = (message = "") => {
  const text = normalizeCoachTextForComparison(message);
  if (!text) return false;

  if (text.length <= 24 && /^(what|why|y|how|who|which|huh|meaning|explain)\b/.test(text)) {
    return true;
  }

  return (
    /\?$/.test(String(message).trim()) ||
    /\b(what is|what are|what do you mean|what does|why|how does|how do|who is|which one|explain|i don t get|i dont get|i don t understand|i dont understand|huh)\b/.test(text)
  );
};

const normalizeHumanReplyIntentText = (message = "") => {
  const text = normalizeCoachTextForComparison(message);
  if (!text) return "";

  return text
    .replace(/\by+e+a+h+\b/g, "yeah")
    .replace(/\by+e+s+\b/g, "yes")
    .replace(/\by+r+s+\b/g, "yes")
    .replace(/\by+e+p+\b/g, "yep")
    .replace(/\by+h+\b/g, "yh")
    .replace(/\bo+k+\b/g, "ok")
    .replace(/\bn+o+\b/g, "no")
    .replace(/\bn+a+h+\b/g, "nah")
    .replace(/\bn+e+h+\b/g, "neh")
    .replace(/\bs+u+r+e+\b/g, "sure")
    .replace(/\bp+l+s+\b/g, "pls")
    .replace(/\bp+l+e+a+s+e+\b/g, "please")
    .replace(/\ba+l+r+i+g+h+t+\b/g, "alright")
    .replace(/\bg+o+\s+a+h+e+a+d+\b/g, "go ahead")
    .trim();
};

const classifyConfirmationReply = (message = "") => {
  const text = normalizeHumanReplyIntentText(message);
  if (!text) return "empty";

  const rejectionPattern = /\b(no|nope|nah|neh|not really|don t|dont|do not|isn t|isnt|wrong|not that|not now|skip|stop|cancel|leave it|keep it simple|not yet)\b/;
  if (rejectionPattern.test(text)) return "reject";

  const acceptancePattern = /\b(yes|yeah|yea|yh|yep|sure|ok|okay|alright|fine|go ahead|continue|carry on|that is ok|thats ok|that works|sounds good|do it|use it|lock it|build it|please|pls|correct|exactly|right|true|i agree|agreed|make it|turn it|show me)\b/;
  if (acceptancePattern.test(text)) return "accept";

  const unclearPattern = /\b(maybe|not sure|i guess|hmm|uhm|uhmm|idk|i don t know|i dont know|confused|depends|whatever|anything|anyone|somehow)\b/;
  if (unclearPattern.test(text) || text.length <= 18) return "unclear";

  return "other";
};

const isLikelyAcceptanceReply = (message = "") => classifyConfirmationReply(message) === "accept";

const previousAssistantNeedsYesNoAnswer = (message = "") => {
  const text = normalizeCoachTextForComparison(message);
  if (!text) return false;

  const asksOpenQuestion = /\b(what|which|when|where|who|why|how|how many|how much|what time|which days|what day|what date|what level|what kind)\b/.test(text);
  const asksChoiceQuestion =
    /\bor\b/.test(text) &&
    !/\byes or no\b/.test(text) &&
    (
      /\b(do you want|should i|should we|can i|can we|would you like|which one|what kind|what type|make it|keep it|use)\b/.test(text) ||
      /\b(one day|one week|one month|simple|strict|nigerian|general|every day|weekdays|selected days|beginner|intermediate|advanced)\b/.test(text)
    );
  if (asksOpenQuestion || asksChoiceQuestion) return false;

  return (
    /\b(want me to|would you like|should i|should we|can i|can we|shall i|shall we|is that ok|is this ok|is that okay|does that work|does this work|does that look right|does this look right|are you okay with that|should i use that|can i use that)\b/.test(text) ||
    /\bdo you want\b[\s\S]{0,140}\b(plan|guide|routine|goal card|build|turn|make|continue|start|lock|use)\b/.test(text) ||
    /\b(if you want|if you d like|if you would like)\b[\s\S]{0,140}\b(i can|we can|i will|we will|i ll|we ll)\b/.test(text)
  );
};

const messageLooksLikeConcreteAnswer = (message = "") => {
  const text = normalizeHumanReplyIntentText(message);
  if (!text) return false;

  return (
    /\b\d{1,2}\s*(am|pm)\b/.test(text) ||
    /\b\d{1,2}:\d{2}\b/.test(text) ||
    /\b(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thurs|thursday|fri|friday|sat|saturday|sun|sunday|weekend|weekdays|every day|daily|full week|whole week)\b/.test(text) ||
    /\b(one day|one week|one month|one year|a day|a week|a month|a year)\b/.test(text) ||
    /\b\d+\s*(minute|minutes|min|mins|hour|hours|day|days|week|weeks|month|months|year|years)\b/.test(text) ||
    /\b(today|tomorrow|next week|next month|next monday|next tuesday|next wednesday|next thursday|next friday|next saturday|next sunday)\b/.test(text) ||
    /\b(beginner|intermediate|advanced|morning|afternoon|evening|night|simple|strict|loose|nigerian|general|local|breakfast|lunch|dinner|snacks|snack)\b/.test(text)
  );
};
const inferSelectedDaysFromText = (message = "") => {
  const text = normalizeHumanReplyIntentText(message);
  if (!text) return [];

  const rangeSeparators = "(?:-|to|till|until|through|thru|;|:)";
  if (new RegExp(`\\b(every day|daily|all days|mon(?:day)?\\s*${rangeSeparators}\\s*sun(?:day)?)\\b`).test(text)) {
    return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  }
  if (new RegExp(`\\b(weekdays|mon(?:day)?\\s*${rangeSeparators}\\s*fri(?:day)?)\\b`).test(text)) {
    return ["Mon", "Tue", "Wed", "Thu", "Fri"];
  }
  if (new RegExp(`\\b(weekends|sat(?:urday)?\\s*${rangeSeparators}\\s*sun(?:day)?)\\b`).test(text)) {
    return ["Sat", "Sun"];
  }

  const compactText = text.replace(/\s+/g, "");
  if (/\bmonfri\b/.test(compactText)) return ["Mon", "Tue", "Wed", "Thu", "Fri"];
  if (/\bsatsun\b/.test(compactText)) return ["Sat", "Sun"];

  const dayMap = [
    ["Mon", /\b(mon|monday|mondays)\b/],
    ["Tue", /\b(tue|tues|tuesday|tuesdays)\b/],
    ["Wed", /\b(wed|wednesday|wednesdays)\b/],
    ["Thu", /\b(thu|thur|thurs|thursday|thursdays)\b/],
    ["Fri", /\b(fri|friday|fridays)\b/],
    ["Sat", /\b(sat|saturday|saturdays)\b/],
    ["Sun", /\b(sun|sunday|sundays)\b/],
  ];

  return dayMap.filter(([, pattern]) => pattern.test(text)).map(([day]) => day);
};

const replyAsksForResolvedDetail = (reply = "", checklist = {}) => {
  const text = normalizeCoachTextForComparison(reply);
  if (!text) return false;

  return (
    (checklist.selectedDaysComplete && /\b(which days|what days|days should this happen|every day|mon to fri|specific days)\b/.test(text)) ||
    (checklist.sessionTimesComplete && /\b(what time|time should|time of day|when should|when do you want)\b/.test(text)) ||
    (checklist.durationResolved && /\b(how many weeks|how many months|how long|recommend .*weeks|recommend .*months)\b/.test(text)) ||
    (checklist.goalStartDateComplete && /\b(start today|start tomorrow|start date|when should this start|should this start)\b/.test(text))
  );
};

const isPrematureFinalSummaryReply = (reply = "") => {
  const text = normalizeCoachTextForComparison(reply);
  if (!text) return false;

  return (
    /\b(here is|here s|heres)\b[\s\S]{0,80}\b(simple plan|full summary|summary|plan i am about to build|plan)\b/.test(text) &&
    /\b(does this look right|does that look right|is this right|is that right)\b/.test(text)
  );
};

const buildUnclearConfirmationReply = (previousReply = "") => {
  const text = normalizeCoachTextForComparison(previousReply);

  if (/\b(if you want|want me to|turn it into|full day|food guide|meal guide|guide)\b/.test(text)) {
    return "I want to make sure I follow you. Should I continue with that direction, or change it?";
  }

  if (/\b(build|goal card|plan|routine|lock|use that|does that look right)\b/.test(text)) {
    return "I want to be sure before I lock it in. Should I build it like that, or should we adjust something?";
  }

  return "I am not fully sure what you mean yet. What should I do next?";
};
const isFoodGuideConversation = (...values) => {
  const text = normalizeCoachTextForComparison(values.filter(Boolean).join(" "));
  return /\b(food|meal|diet|balanced|breakfast|lunch|dinner|nigerian food|guide|plate|carb|protein|vegetable)\b/.test(text);
};
const userExplicitlyWantsScheduledGoal = (...values) => {
  const text = normalizeCoachTextForComparison(values.filter(Boolean).join(" "));
  return /\b(goal card|shift|reminder|notify|notification|track it|track this|add to my goals|add goal|save as goal|schedule it|remind me)\b/.test(text);
};
const userWantsPlanGuide = (...values) => {
  const text = normalizeCoachTextForComparison(values.filter(Boolean).join(" "));
  if (!text) return false;

  return (
    /\b(routine|plan guide|action guide|full plan|quick plan|simple plan|step by step|steps|routine guide|meal guide|food guide|full week guide|week guide|month guide|guide i can follow|something i can follow|actions i can follow|something to follow)\b/.test(text) ||
    /\b(a guide|the guide|that guide|make it a guide|turn it into a guide|give me like that|give me the guide|show me the guide)\b/.test(text) ||
    /\b(turn|make|shape|create|build)\b[\s\S]{0,80}\b(plan|guide|routine)\b/.test(text) ||
    /\b(plan|guide)\b[\s\S]{0,80}\b(meals|walking|workout|study|practice|actions|steps)\b/.test(text)
  );
};

const userWantsAdviceOnly = (...values) => {
  const text = normalizeCoachTextForComparison(values.filter(Boolean).join(" "));
  if (!text) return false;

  return /\b(simple advice|advice only|just advice|keep it as advice|chat only|do not save|don't save|dont save|no goal card|no reminders|do not make a goal|don't make a goal|dont make a goal|explain|what is|what does|meaning)\b/.test(text);
};

const shouldOfferPlanGuideFromAdvice = ({ latestUserMessage = "", previousAssistantReply = "", currentDraft = {} } = {}) => {
  return false;
};

const isFoodGuideOnlyConversation = (...values) => {
  const text = normalizeCoachTextForComparison(values.filter(Boolean).join(" "));
  if (!isFoodGuideConversation(text)) return false;
  if (userExplicitlyWantsScheduledGoal(text)) return false;
  return /\b(guide|meal plan|food guide|diet|balanced diet|loose|strict|nigerian|breakfast|lunch|dinner|snack|snacks|healthy|weight gain|weight loss|full week|month)\b/.test(text);
};

const hasFoodGuideAlreadyBeenShown = (...values) => {
  const text = normalizeCoachTextForComparison(values.filter(Boolean).join(" "));
  return (
    /\b(simple sample week|full week food guide|mon\b[\s\S]{0,80}\btue\b[\s\S]{0,80}\bwed\b)/.test(text) ||
    /\bkeep snacks small|swap similar foods|repeat this weekly\b/.test(text)
  );
};

const buildFoodGuideCloseReply = ({ conversationText = "" } = {}) => {
  const text = normalizeCoachTextForComparison(conversationText);
  const style = /\bnigerian|local\b/.test(text) ? "Nigerian foods" : "general foods";
  return `Good. Use that as your base week, then repeat it and swap similar ${style} so it does not get boring. Want me to adjust it for cheaper foods, weight gain, or weight loss?`;
};

const buildFoodGuideProgressReply = ({ conversationText = "", latestUserMessage = "", previousAssistantReply = "" } = {}) => {
  const text = normalizeCoachTextForComparison(`${conversationText} ${latestUserMessage}`);
  const hasLength = /\b(1 month|one month|month|4 weeks|four weeks|week|7 day|7 days|full week|whole week)\b/.test(text);
  const hasFoodStyle = /\b(nigerian|local|general|common foods|foods i already eat|fresh plan)\b/.test(text);
  const hasAim = /\b(healthy|health|weight gain|gain weight|weight loss|lose weight|muscle|balanced)\b/.test(text);
  const hasLooseChoice = /\b(loose|strict|simple|flexible|easy style|easy to follow)\b/.test(text);
  const hasMeals = /\b(3 meals|three meals|morning afternoon night|breakfast lunch dinner|snack|snacks|small snacks)\b/.test(text);

  if (hasFoodGuideAlreadyBeenShown(previousAssistantReply, conversationText) && classifyConfirmationReply(latestUserMessage) === "accept") {
    return buildFoodGuideCloseReply({ conversationText });
  }

  if (!hasLength) {
    return "Good. Should I make it for one week or one month?";
  }
  if (!hasFoodStyle) {
    return "Good. Should I use Nigerian foods or keep it general?";
  }
  if (!hasAim) {
    return "Good. Is this mainly for staying healthy, weight gain, or weight loss?";
  }
  if (!hasLooseChoice) {
    return "Good. Should it be a loose guide you can follow, or a strict meal list?";
  }
  if (!hasMeals) {
    return "Good. Should I include only 3 meals, or 3 meals plus small snacks?";
  }

  if (/\bnigerian|local\b/.test(text)) {
    return "Here is a simple sample week: Mon: oats or pap, rice with fish, beans and plantain. Tue: bread and egg, yam porridge, swallow with vegetable soup. Wed: custard with groundnut, jollof rice with chicken, moi-moi with fruit. Thu: sweet potato and egg, beans and garri, rice with vegetables. Fri: pap with akara, spaghetti with fish, yam and egg sauce. Sat: bread with tea and egg, swallow with egusi, rice and beans. Sun: oats with banana, chicken stew with rice, light soup with swallow. Keep snacks small: fruit, groundnut, yoghurt, or boiled egg.";
  }

  return "Here is a simple sample week: Mon: oats, chicken rice bowl, pasta with vegetables. Tue: eggs and toast, tuna sandwich, potatoes with fish. Wed: yoghurt with fruit, rice with beans, chicken salad wrap. Thu: cereal or oats, pasta with egg, fish with vegetables. Fri: eggs with bread, rice with chicken, soup with potatoes. Sat: smoothie with toast, noodles with vegetables and egg, beans with rice. Sun: oats with banana, chicken stew with rice, light dinner with fish and vegetables. Keep snacks small: fruit, yoghurt, nuts, boiled egg, or peanut butter toast.";
};

const userWantsNoMoreQuestions = (message = "") => {
  const text = normalizeHumanReplyIntentText(message);
  return /\b(nothing else|nothing more|no more questions|no more question|that s all|thats all|that is all|just that|only that|stop asking|no need|dont ask|don t ask)\b/.test(text);
};

const previousAssistantAskedForGoalCard = (message = "") => {
  const text = normalizeCoachTextForComparison(message);
  return /\b(goal card|build it as a goal|make it a goal|turn it into a goal|build the plan|build it now|build this now|full\b[\s\S]{0,40}\bplan now|lock it in|ready to build)\b/.test(text);
};

const inferCoachMode = ({ latestUserMessage = "", currentDraft = {}, previousAssistantReply = "" } = {}) => {
  const text = normalizeHumanReplyIntentText(latestUserMessage);
  const combined = normalizeCoachTextForComparison(`${latestUserMessage} ${previousAssistantReply}`);

  if (isExplicitGoalBuildRequest(latestUserMessage) || previousAssistantAskedForGoalCard(previousAssistantReply)) {
    return "quick_build";
  }

  if (currentDraft?.shouldBuildGoalCard) return "quick_build";

  if (/\b(add|create|set|make|build|remind|reminder|shift|goal card)\b/.test(text) && /\b(today|tomorrow|every|mon|tue|wed|thu|fri|sat|sun|am|pm|morning|afternoon|night|\d)\b/.test(text)) {
    return "quick_build";
  }

  if (/\b(how do i|help me|i need|i want|struggling|cannot|can t|cant|stop|improve|become|achieve)\b/.test(combined)) {
    return "coach";
  }

  return "coach";
};

const buildAcceptedOfferNextStepReply = ({ previousReply = "", goalDraft = {}, goal = "", checklist = null } = {}) => {
  const contextText = [previousReply, goal, goalDraft?.memorySummary, goalDraft?.coreProblem, goalDraft?.suggestedSolution]
    .filter(Boolean)
    .join(" ");
  const pickAcceptedNextQuestion = (type) => {
    const seedText = `${type}|${contextText}|${goalDraft?.goalTitle || goalDraft?.title || ""}`;
    const seed = Array.from(seedText).reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const variants = {
      guideLength: [
        "Good. Should I make it for one day, one week, or one month?",
        "Nice. Should this cover one day, a full week, or a month?",
        "Good. How far should I shape it: one day, one week, or one month?",
      ],
      days: [
        "Good. What days should I place this on?",
        "Good. Should this run every day, weekdays, or only selected days?",
        "Nice. Which days fit best for this routine?",
        "Good. Do you want this daily, Mon to Fri, or on specific days?",
      ],
      time: [
        "Good. What time should we use for it?",
        "Good. What time of day should I place this?",
        "Nice. When should this happen during the day?",
        "Good. What start time works best?",
      ],
      start: [
        "Good. Should this start today or another day?",
        "Good. When should this begin?",
        "Nice. Should I start it today, tomorrow, or another day?",
        "Good. What start day should I use?",
      ],
    };
    const options = variants[type] || variants.days;
    return options[seed % options.length];
  };

  if (isFoodGuideConversation(contextText)) {
    return pickAcceptedNextQuestion("guideLength");
  }

  if (checklist && !checklist.selectedDaysComplete) {
    return pickAcceptedNextQuestion("days");
  }

  if (checklist && !checklist.sessionTimesComplete) {
    return pickAcceptedNextQuestion("time");
  }

  if (checklist && !checklist.goalStartDateComplete) {
    return pickAcceptedNextQuestion("start");
  }

  if (checklist && !checklist.durationResolved) {
    return buildDurationRecommendationReply(goalDraft);
  }

  if (/\b(goal card|build|plan|routine)\b/.test(normalizeCoachTextForComparison(previousReply))) {
    return "Good. I will keep it simple and build from what you gave me.";
  }

  return "Good. I will continue from there.";
};

const replyLooksLikeRepeatedOffer = (reply = "", previousReply = "") => {
  const current = normalizeCoachTextForComparison(reply);
  const previous = normalizeCoachTextForComparison(previousReply);
  if (!current || !previous) return false;

  return (
    current === previous ||
    (/\b(if you want|want me to|turn it into|i can turn|i can make|i can build)\b/.test(current) &&
      /\b(if you want|want me to|turn it into|i can turn|i can make|i can build)\b/.test(previous))
  );
};

const isDurationProposalReply = (reply = "") => {
  const text = normalizeCoachTextForComparison(reply);
  return (
    /\brecommend\b/.test(text) &&
    /\b(day|days|week|weeks|month|months|year|years)\b/.test(text) &&
    /\b(okay|ok|right|work|is that)\b/.test(text)
  );
};

const isRepeatedCoachReply = (reply = "", previousReply = "") => {
  const current = normalizeCoachTextForComparison(reply);
  const previous = normalizeCoachTextForComparison(previousReply);

  return Boolean(current && previous && current === previous);
};

const usesFinalQuestionWording = (reply = "") => {
  const text = normalizeCoachTextForComparison(reply);

  return /\b(one last thing|last question|final question|one more thing|one quick thing left|last thing|final detail|one last detail)\b/.test(text);
};

const softenPrematureFinalQuestionWording = (reply = "") => {
  return String(reply ?? "")
    .replace(/\bOne last thing[:,]?\s*/gi, "One useful thing: ")
    .replace(/\bOne quick thing left[:,]?\s*/gi, "One useful thing: ")
    .replace(/\bLast question[:,]?\s*/gi, "Next question: ")
    .replace(/\bFinal question[:,]?\s*/gi, "Next question: ")
    .replace(/\bOne more thing[:,]?\s*/gi, "One useful thing: ")
    .replace(/\bLast thing[:,]?\s*/gi, "One useful thing: ")
    .replace(/\bFinal detail[:,]?\s*/gi, "Next detail: ")
    .replace(/\bOne last detail[:,]?\s*/gi, "One useful detail: ");
};

const countIncompleteChecklistItems = (checklist = {}) => {
  return Object.values(checklist).filter((value) => !Boolean(value)).length;
};

const normalizeResponseMode = (value = "") => {
  const mode = String(value ?? "").trim().toLowerCase();

  return [
    "advice_first",
    "plan_guide",
    "goal_planning",
    "quick_build",
    "edit_goal",
    "normal_chat",
  ].includes(mode)
    ? mode
    : "";
};

const isExplicitGoalBuildRequest = (message = "") => {
  const text = normalizeCoachTextForComparison(message);

  if (!text) return false;

  return /\b(build|create|make|add|generate|turn|set|lock)\b.*\b(goal|plan|routine|card|shift|reminder)\b/.test(text) ||
    /\b(add it|build it|create it|make it|generate it|turn it into a plan|turn that into a plan|lock it in|save it)\b/.test(text);
};

const shouldStayInAdviceMode = (goalDraft = {}, latestUserMessage = "") => {
  const responseMode = normalizeResponseMode(goalDraft?.responseMode);
  const shouldBuildGoalCard = Boolean(goalDraft?.shouldBuildGoalCard);

  if (shouldBuildGoalCard || isExplicitGoalBuildRequest(latestUserMessage)) return false;

  return responseMode === "advice_first" || responseMode === "normal_chat";
};





const getGoalDraftSearchText = (goalDraft = {}) => {
  const knownFacts = isPlainObject(goalDraft?.knownFacts) ? goalDraft.knownFacts : {};
  const goalParts = isPlainObject(goalDraft?.goalParts) ? goalDraft.goalParts : {};

  return [
    goalDraft?.goalTitle,
    goalDraft?.coreProblem,
    goalDraft?.suggestedSolution,
    goalDraft?.recommendedStructure,
    goalDraft?.level,
    ...Object.values(knownFacts),
    ...Object.values(goalParts),
  ]
    .map((value) => {
      if (isPlainObject(value)) return JSON.stringify(value);
      return String(value ?? "");
    })
    .join(" ")
    .toLowerCase();
};

const getRecommendedDurationForGoal = (goalDraft = {}) => {
  const existingLabel = String(goalDraft?.estimatedDurationLabel ?? "").trim();
  const existingDays = Number(goalDraft?.estimatedDurationDays ?? 0);

  if (existingLabel && existingLabel.toLowerCase() !== "no end date") {
    return { label: existingLabel, days: existingDays || 0 };
  }

  const text = getGoalDraftSearchText(goalDraft);

  if (
    text.includes("confidence") ||
    text.includes("speaking") ||
    text.includes("public speaking") ||
    text.includes("eye contact") ||
    text.includes("posture")
  ) {
    return { label: "4 weeks", days: 28 };
  }

  if (
    text.includes("program") ||
    text.includes("coding") ||
    text.includes("flutter") ||
    text.includes("developer")
  ) {
    return { label: "3 months", days: 90 };
  }

  if (
    text.includes("weight") ||
    text.includes("bulk") ||
    text.includes("fitness") ||
    text.includes("workout")
  ) {
    return { label: "8 weeks", days: 56 };
  }

  if (text.includes("exam") || text.includes("academic") || text.includes("study")) {
    return { label: "8 weeks", days: 56 };
  }

  return { label: "4 weeks", days: 28 };
};

const buildDurationRecommendationReply = (goalDraft = {}) => {
  const recommendation = getRecommendedDurationForGoal(goalDraft);
  const reasonText = getGoalDraftSearchText(goalDraft).includes("confidence")
    ? "That is long enough to build proof through repetition without making it feel heavy."
    : "That gives the plan enough time to create visible progress without dragging for too long.";

  return `For this, I recommend ${recommendation.label}. ${reasonText} Is that okay?`;
};

const inferDurationSuggestionFromReply = (reply = "") => {
  const text = String(reply ?? "");
  if (!/\b(recommend|suggest|use|make it|set it)\b/i.test(text)) return null;

  const match = text.match(/\b(\d{1,2})\s*(week|weeks|month|months|day|days|year|years)\b/i);
  if (!match) return null;

  const count = Number(match[1] ?? 0);
  const unit = String(match[2] ?? "").toLowerCase();
  if (!count) return null;

  const daysPerUnit = unit.startsWith("day")
    ? 1
    : unit.startsWith("week")
      ? 7
      : unit.startsWith("month")
        ? 30
        : 365;
  const singularUnit = unit.replace(/s$/, "");

  return {
    estimatedDurationDays: count * daysPerUnit,
    estimatedDurationLabel: `${count} ${singularUnit}${count === 1 ? "" : "s"}`,
    durationResolved: false,
    reason: `suggested ${count} ${singularUnit}${count === 1 ? "" : "s"} duration`,
  };
};

const buildGoalFinalSummaryReply = (goalDraft = {}) => {
  const title = getBestGoalTitle(
    goalDraft,
    goalDraft?.coreProblem || goalDraft?.suggestedSolution || "this goal",
  );
  const knownFacts = isPlainObject(goalDraft?.knownFacts)
    ? goalDraft.knownFacts
    : {};
  const details = [];

  const successTarget = String(knownFacts.successTarget ?? "").trim();
  if (successTarget && successTarget.toLowerCase() !== title.toLowerCase()) {
    details.push(`target: ${successTarget}`);
  }

  const daysText = formatGoalDaysForUser(goalDraft?.selectedDays);
  if (daysText) details.push(daysText);

  const startDate = String(goalDraft?.goalStartDate ?? "").trim();
  if (startDate) details.push(`starts ${formatGoalDateForUser(startDate)}`);

  const duration = String(goalDraft?.estimatedDurationLabel ?? "").trim();
  const endDate = String(goalDraft?.goalEndDate ?? "").trim();
  if (endDate) {
    details.push(`ends ${formatGoalDateForUser(endDate)}`);
  } else if (duration && duration.toLowerCase() !== "no end date") {
    details.push(duration);
  } else {
    details.push("no end date");
  }

  const sessionTimes = normalizeGoalSessionTimes(
    goalDraft?.sessionTimes,
    goalDraft?.sessionTime,
  );
  if (sessionTimes.length > 0) {
    details.push(
      sessionTimes
        .map(
          (session) =>
            `${formatGoalTimeForUser(session.startTime)} to ${formatGoalTimeForUser(
              session.endTime,
            )}`,
        )
        .join(", "),
    );
  }

  const detailText = details.length > 0 ? `, ${details.join(", ")}` : "";
  return `Here is the plan I am about to build: ${title}${detailText}. Does that look right?`;
};

const hasStructuredGoalParts = (goalDraft = {}) => {
  const goalParts = isPlainObject(goalDraft?.goalParts) ? goalDraft.goalParts : {};
  const knownFacts = isPlainObject(goalDraft?.knownFacts) ? goalDraft.knownFacts : {};

  return (
    Object.keys(goalParts).length > 0 ||
    Object.values(knownFacts).some((value) => isMeaningfulStructuredValue(value))
  );
};

const hasMeaningfulGoalDirection = (goalDraft = {}) => {
  return [
    goalDraft?.goalTitle,
    goalDraft?.coreProblem,
    goalDraft?.suggestedSolution,
    goalDraft?.knownFacts?.direction,
    goalDraft?.knownFacts?.successTarget,
  ].some((value) => String(value ?? "").trim().length > 0);
};

const hasEnoughStructuredGoalContext = (goalDraft = {}) => {
  const isOneTime = goalDraft.goalPlanningType === "one_time";
  const isRoutine = goalDraft.goalPlanningType === "routine";
  const hasDays = isOneTime || normalizeGoalSelectedDays(goalDraft.selectedDays).length > 0;
  const hasTime =
    isOneTime ||
    normalizeGoalSessionTimes(goalDraft.sessionTimes, goalDraft.sessionTime).length > 0;
  const hasDuration = isOneTime || isRoutine || Boolean(goalDraft.durationResolved);
  const hasLevel =
    isOneTime ||
    Boolean(goalDraft.levelResolved) ||
    String(goalDraft.level ?? "").trim().length > 0;

  return (
    Boolean(goalDraft.goalPlanningType) &&
    hasMeaningfulGoalDirection(goalDraft) &&
    hasStructuredGoalParts(goalDraft) &&
    hasDays &&
    hasTime &&
    hasDuration &&
    hasLevel
  );
};

const buildMissingStructureReply = (goalDraft = {}) => {
  const isOneTime = goalDraft.goalPlanningType === "one_time";
  if (!goalDraft.goalPlanningType) {
    return "I understand the goal. I will recommend a realistic structure first, then you can approve or adjust it.";
  }
if (
  !isOneTime &&
  goalDraft.goalPlanningType !== "routine" &&
  !goalDraft.durationResolved
) {
  return buildDurationRecommendationReply(goalDraft);
}
  if (!isOneTime && normalizeGoalSelectedDays(goalDraft.selectedDays).length === 0) {
    return "I can recommend the best days for this goal, then you can adjust them if they clash with your life. Is that okay?";
  }
  if (!isOneTime && normalizeGoalSessionTimes(goalDraft.sessionTimes, goalDraft.sessionTime).length === 0) {
    return "What time should we use for it? I will keep it away from your busy times.";
  }
  if (!isOneTime && !goalDraft.levelResolved && !String(goalDraft.level ?? "").trim()) {
    return "What level do you rate your workouts right now: beginner, intermediate, or advanced?";
  }
  return buildGoalFinalSummaryReply(goalDraft);
};
const buildGoalStructureConfirmationReply = (goalDraft = {}) => {
  const title = getBestGoalTitle(goalDraft, goalDraft?.userIntent || goalDraft?.coreProblem || "this goal");

  const sessionTimes = normalizeGoalSessionTimes(
    goalDraft?.sessionTimes,
    goalDraft?.sessionTime,
  );

  const timeText = sessionTimes.length
    ? sessionTimes
        .map(
          (session) =>
            `${formatGoalTimeForUser(session.startTime)} to ${formatGoalTimeForUser(
              session.endTime,
            )}`,
        )
        .join(", ")
    : "the time you gave";

  const days = normalizeGoalSelectedDays(goalDraft?.selectedDays);
  const dayText =
    days.length >= 7
      ? "every day"
      : days.length > 0
        ? `on ${days.join(", ")}`
        : "on the days you picked";

  const endText = String(goalDraft?.goalEndDate ?? "").trim()
    ? `until ${goalDraft.goalEndDate}`
    : "with no end date";

  return `Just to confirm: you want ${title}, ${timeText}, ${dayText}, ${endText}. Is this right?`;
};

const roundUpToNearest30Minutes = (minutes) => {
  return Math.ceil(minutes / 30) * 30;
};

const ensureFutureForToday = (item, now = new Date()) => {
  const todayLabel = getCurrentWeekdayLabel(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const targetType = String(item.targetType ?? "weekday");
  const weekdayLabel = String(item.weekdayLabel ?? "Mon");
  const startMinutes = parseTimeToMinutes(item.startTime);
  const endMinutes = parseTimeToMinutes(item.endTime);

  if (targetType !== "weekday" || weekdayLabel !== todayLabel) {
    return item;
  }

  let duration = endMinutes - startMinutes;

  if (duration < 0) {
    duration += 24 * 60;
  }

  if (duration === 0) {
    duration = 60;
  }

  if (startMinutes <= nowMinutes) {
    const nextSafeStart = roundUpToNearest30Minutes(nowMinutes + 45);
    let nextSafeEnd = nextSafeStart + duration;

    if (nextSafeEnd > 23 * 60 + 59) {
      nextSafeEnd = 23 * 60 + 59;
    }

    return {
      ...item,
      startTime: formatMinutesToTime(nextSafeStart),
      endTime: formatMinutesToTime(nextSafeEnd),
    };
  }

  return item;
};

const areTimeRangesOverlapping = (startA, endA, startB, endB) => {
  return startA < endB && startB < endA;
};

const removeOverlappingShifts = (items = []) => {
  const sorted = [...items].sort((a, b) => {
    const aTarget = String(a.targetType ?? "weekday");
    const bTarget = String(b.targetType ?? "weekday");

    if (aTarget !== bTarget) {
      return aTarget.localeCompare(bTarget);
    }

    if (a.weekdayLabel !== b.weekdayLabel) {
      return weekDays.indexOf(a.weekdayLabel) - weekDays.indexOf(b.weekdayLabel);
    }

    return parseTimeToMinutes(a.startTime) - parseTimeToMinutes(b.startTime);
  });

  const cleaned = [];

  for (const item of sorted) {
    const itemStart = parseTimeToMinutes(item.startTime);
    const itemEnd = parseTimeToMinutes(item.endTime);
    const itemTargetType = String(item.targetType ?? "weekday");

    const overlaps = cleaned.some((existing) => {
      const existingTargetType = String(existing.targetType ?? "weekday");

      if (existingTargetType !== itemTargetType) return false;

      if (
        itemTargetType === "weekday" &&
        existing.weekdayLabel !== item.weekdayLabel
      ) {
        return false;
      }

      if (
        itemTargetType === "date" &&
        String(existing.plannedDate ?? "") !== String(item.plannedDate ?? "")
      ) {
        return false;
      }

      if (
        (itemTargetType === "week" ||
          itemTargetType === "month" ||
          itemTargetType === "year") &&
        String(existing.targetKey ?? "") !== String(item.targetKey ?? "")
      ) {
        return false;
      }

      const existingStart = parseTimeToMinutes(existing.startTime);
      const existingEnd = parseTimeToMinutes(existing.endTime);

      return areTimeRangesOverlapping(
        itemStart,
        itemEnd,
        existingStart,
        existingEnd,
      );
    });

    if (!overlaps) {
      cleaned.push(item);
    }
  }

  return cleaned;
};

const getTimePeriodWindow = (startMinutes) => {
  if (startMinutes < 12 * 60) {
    return { start: 6 * 60, end: 11 * 60 + 30 }; // morning
  }

  if (startMinutes < 17 * 60) {
    return { start: 12 * 60, end: 16 * 60 + 30 }; // afternoon
  }

  return { start: 17 * 60, end: 21 * 60 + 30 }; // evening
};

const getShiftTargetIdentity = (shift) => {
  const targetType = String(shift.targetType ?? "weekday");

  if (targetType === "weekday") {
    return `weekday:${shift.weekdayLabel ?? ""}`;
  }

  if (targetType === "date") {
    return `date:${shift.plannedDate ?? shift.targetKey ?? ""}`;
  }

  if (targetType === "week") {
    return `week:${shift.targetKey ?? shift.targetLabel ?? ""}`;
  }

  if (targetType === "month") {
    return `month:${shift.targetKey ?? shift.targetLabel ?? ""}`;
  }

  if (targetType === "year") {
    return `year:${shift.targetKey ?? shift.targetLabel ?? ""}`;
  }

  return `${targetType}:unknown`;
};

const flattenExistingScheduleShifts = (existingSchedule = []) => {
  if (!Array.isArray(existingSchedule)) return [];

  return existingSchedule.flatMap((goal) =>
    (goal.shifts || []).map((shift) => ({
      goalTitle: goal.goalTitle || "Untitled goal",
      title: shift.title || goal.goalTitle || "Existing shift",
      startTime: shift.startTime,
      endTime: shift.endTime,
      weekdayLabel: shift.weekdayLabel,
      plannedDate: shift.plannedDate,
      targetType: shift.targetType,
      targetKey: shift.targetKey,
      targetLabel: shift.targetLabel,
    })),
  );
};

const buildExistingBusyTimesMemory = (existingSchedule = []) => {
  return flattenExistingScheduleShifts(existingSchedule)
    .map((shift) => ({
      source: "existing_goal",
      goalTitle: String(shift.goalTitle ?? "Untitled goal").trim(),
      title: String(shift.title ?? "Existing shift").trim(),
      startTime: normalizeGoalTimeValue(shift.startTime),
      endTime: normalizeGoalTimeValue(shift.endTime),
      weekdayLabel: String(shift.weekdayLabel ?? "").trim(),
      plannedDate: shift.plannedDate ? String(shift.plannedDate).trim() : "",
      targetType: String(shift.targetType ?? "").trim(),
      targetKey: String(shift.targetKey ?? "").trim(),
      targetLabel: String(shift.targetLabel ?? "").trim(),
    }))
    .filter((shift) => shift.startTime && shift.endTime);
};
const doesShiftConflict = (candidate, busyShifts) => {
  const candidateTarget = getShiftTargetIdentity(candidate);
  const candidateStart = parseTimeToMinutes(candidate.startTime);
  const candidateEnd = parseTimeToMinutes(candidate.endTime);

  return busyShifts.some((busy) => {
    if (getShiftTargetIdentity(busy) !== candidateTarget) return false;

    return areTimeRangesOverlapping(
      candidateStart,
      candidateEnd,
      parseTimeToMinutes(busy.startTime),
      parseTimeToMinutes(busy.endTime),
    );
  });
};

const applyPreferredSessionTimesToPlan = (
  rawPlan = [],
  currentGoalMeta = null,
) => {
  const preferredTimes = normalizeGoalSessionTimes(
    currentGoalMeta?.sessionTimes,
    currentGoalMeta?.sessionTime,
  );

  if (preferredTimes.length !== 1) return rawPlan;

  const preferred = preferredTimes[0];

  return rawPlan.map((shift) => {
    const targetType = String(shift?.targetType ?? "weekday");
    const timeframeType = String(shift?.timeframeType ?? "day");

    if (
      timeframeType !== "day" ||
      (targetType !== "weekday" && targetType !== "date")
    ) {
      return shift;
    }

    return {
      ...shift,
      startTime: preferred.startTime,
      endTime: preferred.endTime,
    };
  });
};

const removeDuplicatePreferredSessionShifts = (planItems = []) => {
  const seen = new Set();

  return planItems.filter((shift) => {
    const targetIdentity = getShiftTargetIdentity(shift);
    const startTime = String(shift?.startTime ?? "");
    const endTime = String(shift?.endTime ?? "");

    const key = `${targetIdentity}|${startTime}|${endTime}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
};

const autoAdjustPlanAgainstExistingSchedule = (
  rawPlan = [],
  existingSchedule = [],
) => {
  const existingBusyShifts = flattenExistingScheduleShifts(existingSchedule);
  const adjustedBusyShifts = [...existingBusyShifts];

  return rawPlan.map((shift) => {
    let adjustedShift = { ...shift };

    let startMinutes = parseTimeToMinutes(adjustedShift.startTime);
    let endMinutes = parseTimeToMinutes(adjustedShift.endTime);

    let duration = endMinutes - startMinutes;
    if (duration <= 0) duration = 60;

    if (!doesShiftConflict(adjustedShift, adjustedBusyShifts)) {
      adjustedBusyShifts.push(adjustedShift);
      return adjustedShift;
    }

    const preferredWindow = getTimePeriodWindow(startMinutes);

    const candidateWindows = [
      preferredWindow,
      { start: 6 * 60, end: 11 * 60 + 30 },
      { start: 12 * 60, end: 16 * 60 + 30 },
      { start: 17 * 60, end: 21 * 60 + 30 },
    ];

    let foundSlot = null;

      const candidateStarts = candidateWindows
      .flatMap((window) => {
        const starts = [];

        for (
          let candidateStart = window.start;
          candidateStart + duration <= window.end;
          candidateStart += 30
        ) {
          starts.push(candidateStart);
        }

        return starts;
      })
      .filter((value, index, items) => items.indexOf(value) === index)
      .sort((a, b) => {
        const distanceDifference =
          Math.abs(a - startMinutes) - Math.abs(b - startMinutes);

        if (distanceDifference !== 0) return distanceDifference;

        // When equally close, prefer a later slot.
        return b - a;
      });

    for (const candidateStart of candidateStarts) {
      const candidateShift = {
        ...adjustedShift,
        startTime: formatMinutesToTime(candidateStart),
        endTime: formatMinutesToTime(candidateStart + duration),
      };

      if (!doesShiftConflict(candidateShift, adjustedBusyShifts)) {
        foundSlot = candidateShift;
        break;
      }
    }

    adjustedShift = foundSlot ?? adjustedShift;
    adjustedBusyShifts.push(adjustedShift);

    return adjustedShift;
  });
};

/* --------------------------- UNSPLASH HELPERS --------------------------- */

const buildUnsplashReferral = (url) => {
  if (!url) return "";
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}utm_source=${UNSPLASH_APP_NAME}&utm_medium=referral`;
};

const inferCategoryFromText = (title = "", goal = "") => {
  const text = `${title} ${goal}`.toLowerCase();

  if (
    text.includes("gym") ||
    text.includes("strength") ||
    text.includes("upper body") ||
    text.includes("lower body") ||
    text.includes("full body") ||
    text.includes("training") ||
    text.includes("workout") ||
    text.includes("bulk") ||
    text.includes("muscle") ||
    text.includes("exercise")
  ) {
    return "workout";
  }

  if (
    text.includes("meal") ||
    text.includes("cook") ||
    text.includes("grocery") ||
    text.includes("protein") ||
    text.includes("dinner") ||
    text.includes("breakfast") ||
    text.includes("food")
  ) {
    return "cooking";
  }

  if (
    text.includes("study") ||
    text.includes("learn") ||
    text.includes("reading") ||
    text.includes("practice") ||
    text.includes("school") ||
    text.includes("exam") ||
    text.includes("focus") ||
    text.includes("jamb") ||
    text.includes("cbt")
  ) {
    return "study";
  }

  if (
    text.includes("sleep") ||
    text.includes("rest") ||
    text.includes("recovery") ||
    text.includes("nap")
  ) {
    return "sleep";
  }

  if (
    text.includes("meditate") ||
    text.includes("mindfulness") ||
    text.includes("breathing") ||
    text.includes("calm") ||
    text.includes("journal")
  ) {
    return "meditation";
  }

  if (
    text.includes("money") ||
    text.includes("budget") ||
    text.includes("finance") ||
    text.includes("income") ||
    text.includes("sales") ||
    text.includes("business") ||
    text.includes("startup") ||
    text.includes("brand") ||
    text.includes("real estate")
  ) {
    return "money";
  }

  return "workout";
};

const buildImageSearchQuery = ({ title = "", goal = "", category = "workout" }) => {
  const text = `${title} ${goal}`.toLowerCase();

  if (category === "workout") {
    if (text.includes("bulk") || text.includes("muscle")) {
      return "muscle building workout gym";
    }
    if (text.includes("stretch") || text.includes("warm")) {
      return "stretching fitness routine";
    }
    return "strength training gym workout";
  }

  if (category === "cooking") {
    if (text.includes("protein")) {
      return "high protein meal prep";
    }
    if (text.includes("breakfast")) {
      return "healthy breakfast meal";
    }
    return "healthy cooking meal prep";
  }

  if (category === "study") {
    if (text.includes("jamb") || text.includes("cbt")) {
      return "student studying for computer based exam";
    }
    if (text.includes("exam")) {
      return "student studying for exam";
    }
    return "focused studying desk productivity";
  }

  if (category === "sleep") {
    return "sleep recovery bedtime calm room";
  }

  if (category === "meditation") {
    return "meditation mindfulness calm breathing";
  }

  if (category === "money") {
    if (text.includes("real estate")) {
      return "real estate planning business office";
    }
    if (text.includes("budget")) {
      return "budget planning finance desk";
    }
    if (text.includes("sales") || text.includes("business")) {
      return "business planning startup laptop";
    }
    return "personal finance money planning";
  }

  return title || goal || "productive lifestyle";
};

const searchUnsplashPhoto = async (query) => {
  if (!UNSPLASH_ACCESS_KEY || !query) return null;

  const url =
    `https://api.unsplash.com/search/photos` +
    `?query=${encodeURIComponent(query)}` +
    `&page=1&per_page=1&orientation=landscape&content_filter=high`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}`,
      "Accept-Version": "v1",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Unsplash search failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const photo = data?.results?.[0];

  if (!photo) return null;

  return {
    imageUri: photo.urls?.regular || photo.urls?.small || null,
    imageThumbUri: photo.urls?.thumb || null,
    unsplashPhotoId: photo.id || null,
    imageAuthor: photo.user?.name || null,
    imageAuthorUsername: photo.user?.username || null,
    imageAuthorUrl: buildUnsplashReferral(photo.user?.links?.html || ""),
    imageUnsplashUrl: buildUnsplashReferral(photo.links?.html || ""),
    imageDownloadLocation: photo.links?.download_location || null,
  };
};

const triggerUnsplashDownload = async (downloadLocation) => {
  if (!UNSPLASH_ACCESS_KEY || !downloadLocation) return;

  const separator = downloadLocation.includes("?") ? "&" : "?";
  const trackedUrl = `${downloadLocation}${separator}client_id=${UNSPLASH_ACCESS_KEY}`;

  try {
    await fetch(trackedUrl, {
      headers: {
        "Accept-Version": "v1",
      },
    });
  } catch (error) {
    console.log("Unsplash download tracking failed:", error.message);
  }
};

/* ---------------------------- AI JSON HELPERS --------------------------- */

const safeJsonParseFromResponse = (text = "") => {
  const cleaned = String(text).replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
};

const normalizeCalendarEditOperations = (operations = []) => {
  if (!Array.isArray(operations)) return [];

  return operations
    .map((operation) => ({
      action: String(operation?.action ?? "").trim(),
      scope: String(operation?.scope ?? "").trim(),
      targetType: String(operation?.targetType ?? "").trim(),
      plannedDate: operation?.plannedDate
        ? String(operation.plannedDate).trim()
        : undefined,
      targetKey: operation?.targetKey
        ? String(operation.targetKey).trim()
        : undefined,
      shiftId: operation?.shiftId
        ? String(operation.shiftId).trim()
        : undefined,
      weekdayLabel: operation?.weekdayLabel
        ? String(operation.weekdayLabel).trim()
        : undefined,
      applyToAllShifts: Boolean(operation?.applyToAllShifts),
      reason: operation?.reason
        ? String(operation.reason).trim()
        : undefined,
    }))
    .filter((operation) => {
      if (
        !["skip", "delete_recurring", "add", "update"].includes(
          operation.action,
        )
      ) {
        return false;
      }

      if (!["one_off", "recurring", "period"].includes(operation.scope)) {
        return false;
      }

      if (
        !["date", "weekday", "week", "month", "year"].includes(
          operation.targetType,
        )
      ) {
        return false;
      }

      if (operation.targetType === "date" && !operation.plannedDate) {
        return false;
      }

      if (
        ["week", "month", "year"].includes(operation.targetType) &&
        !operation.targetKey
      ) {
        return false;
      }

      return true;
    });
};

const calendarExceptionsFromOperations = (operations = []) => {
  return normalizeCalendarEditOperations(operations)
    .filter(
      (operation) =>
        operation.action === "skip" &&
        ["date", "week", "month", "year"].includes(operation.targetType) &&
        (operation.applyToAllShifts || operation.shiftId),
    )
    .map((operation, index) => ({
      id: `calendar-exception-${Date.now()}-${index}-${Math.random()
        .toString(36)
        .slice(2, 9)}`,
      action: "skip",
      targetType: operation.targetType,
      plannedDate: operation.plannedDate,
      targetKey: operation.targetKey,
      shiftId: operation.shiftId,
      applyToAllShifts: operation.applyToAllShifts,
    }));
};

const ensurePlanItemIds = (planItems = []) => {
  return planItems.map((item, index) => ({
    ...item,
    id:
      item?.id ||
      `ai-shift-${Date.now()}-${index}-${Math.random()
        .toString(36)
        .slice(2, 9)}`,
  }));
};


const normalizeImageEditOperations = (operations = []) => {
  if (!Array.isArray(operations)) return [];

  return operations
    .map((operation) => ({
      action: String(operation?.action ?? "").trim(),
      scope: String(operation?.scope ?? "").trim(),
      shiftId: operation?.shiftId ? String(operation.shiftId).trim() : undefined,
      weekdayLabel: operation?.weekdayLabel
        ? String(operation.weekdayLabel).trim()
        : undefined,
      plannedDate: operation?.plannedDate
        ? String(operation.plannedDate).trim()
        : undefined,
      targetType: operation?.targetType
        ? String(operation.targetType).trim()
        : undefined,
      targetKey: operation?.targetKey
        ? String(operation.targetKey).trim()
        : undefined,
      category: operation?.category ? String(operation.category).trim() : undefined,
      imageSearchQuery: operation?.imageSearchQuery
        ? String(operation.imageSearchQuery).trim()
        : undefined,
      imageUri: operation?.imageUri ? String(operation.imageUri).trim() : undefined,
      applyToAllMatchingShifts: Boolean(operation?.applyToAllMatchingShifts),
    }))
    .filter((operation) => operation.action === "change_image");
};

const normalizeAIEditResponse = (parsed) => {
  if (Array.isArray(parsed)) {
    return {
      reply: "Done. I updated the plan.",
      needsMoreInfo: false,
      goalMeta: null,
      plan: parsed,
      calendarEditOperations: [],
      imageEditOperations: [],
    };
  }

  return {
    reply: String(parsed?.reply ?? "").trim(),
    needsMoreInfo: Boolean(parsed?.needsMoreInfo),
    goalMeta:
      parsed?.goalMeta && typeof parsed.goalMeta === "object"
        ? parsed.goalMeta
        : null,
    plan: Array.isArray(parsed?.plan) ? parsed.plan : [],
    calendarEditOperations: normalizeCalendarEditOperations(
      parsed?.calendarEditOperations,
    ),
    imageEditOperations: normalizeImageEditOperations(
      parsed?.imageEditOperations,
    ),
  };
};

const doesImageOperationMatchItem = (operation, item) => {
  if (operation.scope === "all") return true;

  if (operation.scope === "shift") {
    return String(item?.id ?? "") === String(operation.shiftId ?? "");
  }

  if (operation.scope === "weekday") {
    return String(item?.weekdayLabel ?? "") === String(operation.weekdayLabel ?? "");
  }

  if (operation.scope === "date") {
    return String(item?.plannedDate ?? "") === String(operation.plannedDate ?? "");
  }

  if (
    operation.scope === "week" ||
    operation.scope === "month" ||
    operation.scope === "year"
  ) {
    return String(item?.targetKey ?? "") === String(operation.targetKey ?? "");
  }

  return false;
};

const applyUnsplashImageEditOperations = async ({
  planItems = [],
  imageEditOperations = [],
  goal = "",
  includeImages = true,
}) => {
  if (
    !includeImages ||
    !Array.isArray(imageEditOperations) ||
    imageEditOperations.length === 0
  ) {
    return planItems;
  }

  return Promise.all(
    planItems.map(async (item) => {
      const operation = imageEditOperations.find((candidate) =>
        doesImageOperationMatchItem(candidate, item),
      );

      if (!operation) return item;

      if (operation.imageUri) {
        return {
          ...item,
          imageKey: undefined,
          imageUri: operation.imageUri,
          imageThumbUri: null,
          imageAuthor: null,
          imageAuthorUsername: null,
          imageAuthorUrl: null,
          imageUnsplashUrl: null,
        };
      }

      const category = operation.category || item?.category || inferCategoryFromText(item?.title, goal);

      const imageSearchQuery =
        operation.imageSearchQuery ||
        item?.imageSearchQuery ||
        buildImageSearchQuery({
          title: item?.title,
          goal,
          category,
        });

      let unsplashData = null;

      try {
        unsplashData = await searchUnsplashPhoto(imageSearchQuery);

        if (unsplashData?.imageDownloadLocation) {
          triggerUnsplashDownload(unsplashData.imageDownloadLocation);
        }
      } catch (imageError) {
        console.log(
          `Unsplash image edit failed for "${imageSearchQuery}":`,
          imageError.message,
        );
      }

    if (!unsplashData?.imageUri) {
  return {
    ...item,
    imageKey: undefined,
    imageUri: null,
    imageThumbUri: null,
    imageAuthor: null,
    imageAuthorUsername: null,
    imageAuthorUrl: null,
    imageUnsplashUrl: null,
  };
}

      return {
        ...item,
        category,
        imageKey: undefined,
        imageUri: unsplashData.imageUri,
        imageThumbUri: unsplashData.imageThumbUri || null,
        unsplashPhotoId: unsplashData.unsplashPhotoId || null,
        imageAuthor: unsplashData.imageAuthor || null,
        imageAuthorUsername: unsplashData.imageAuthorUsername || null,
        imageAuthorUrl: unsplashData.imageAuthorUrl || null,
        imageUnsplashUrl: unsplashData.imageUnsplashUrl || null,
        imageSearchQuery,
      };
    }),
  );
};

const imageFieldNames = [
  "imageKey",
  "imageUri",
  "imageThumbUri",
  "unsplashPhotoId",
  "imageAuthor",
  "imageAuthorUsername",
  "imageAuthorUrl",
  "imageUnsplashUrl",
  "imageSearchQuery",
];

const restoreUnrequestedImageChanges = ({
  planItems = [],
  originalPlan = [],
  imageEditOperations = [],
}) => {
  return planItems.map((item) => {
    const hasRequestedImageChange = imageEditOperations.some((operation) =>
      doesImageOperationMatchItem(operation, item),
    );

    if (hasRequestedImageChange) return item;

    const original = originalPlan.find(
      (oldItem) =>
        oldItem?.id &&
        item?.id &&
        String(oldItem.id) === String(item.id),
    );

    if (!original) return item;

    const restored = { ...item };

    imageFieldNames.forEach((fieldName) => {
      restored[fieldName] = original[fieldName];
    });

    return restored;
  });
};



const extractPreferredName = (coachContext = "") => {
  const match = String(coachContext).match(/Preferred name:\s*(.+)/i);
  const name = match?.[1]?.trim();

  if (!name || name.toLowerCase() === "not provided") return "";
  return name;
};

const buildSimpleCoachVoiceRules = () => {
  return `
Simple language rules:
- When the user asks who you are, say naturally: "I am Goach, an AI goal coach powered by OpenAI. I help you turn goals, habits, routines, and reminders into realistic plans you can follow."
- Mention OpenAI only when the user asks about your identity, AI, model, or who powers you.
- Use simple everyday words.
- Write like you are chatting with a normal person.
- Keep sentences short.
- Break complex words, app words, school words, fitness words, business words, money words, and technical words into simple words.
- Write so a JSS1 student can understand without asking again.
- If a word may confuse a young student, replace it with a simpler word or explain it in a short phrase.
- Avoid big words, technical terms, and school-style grammar.
- If you must use a fitness, study, business, health, money, or app term, explain it in plain words immediately.
- Prefer "use" instead of "utilize".
- Prefer "start" instead of "commence".
- Prefer "help" instead of "assist".
- Prefer "change" instead of "modify" when speaking to the user.
- Prefer "show" instead of "demonstrate".
- Do not sound like a textbook.
- Do not use motivational fluff.
- Keep the tone warm, clear, and direct.
`.trim();
};

const buildUnderstandingFirstRules = () => {
  return `
Understanding-first Goach rules:
- Do not act like a form collector.
- First understand what the user is really saying.
- The user's message may be a complaint, a struggle, a request, a correction, a normal chat message, or a clear goal.
- If the message is a complaint or struggle, identify the likely root problem before asking schedule questions.
- Examples of complaints or struggles: "I am always distracted", "I cannot focus", "I keep procrastinating", "I am tired", "I do not know what to do", "I keep failing".
- For complaints, first reflect the problem in simple words, then ask one useful cause-finding question OR suggest one practical solution and ask if they want to turn it into a plan.
- Do not ask for time of day, selected days, duration, level, or break days until the user agrees with the solution direction or the goal is clearly understood.
- If the user questions your reply, challenges it, or asks for explanation, answer their concern first. Do not continue collecting form fields in that reply.
- If the user asks what something means, what a tool is, how something works, or why you suggested it, answer that direct question first. Do not recommend duration, days, level, or schedule in that same reply unless the user also clearly asks you to build the plan.
- If the user meaningfully accepts your direction, asks you to continue, asks for guidance, or asks you to take the lead, treat it as permission to move forward using knownFacts. Do not restart discovery or depend on exact phrases.
- If the user is just talking and has no goal yet, respond naturally and ask whether they want help turning it into a goal.
- Understand Nigerian greetings in general, including Pidgin and casual forms like "how far", "howfar", "how u dey", "how you dey", "how now", "wetin dey", and "how body". Treat greetings as normal chat, not as goal titles.
- Goach's fixed response order is: listen -> understand -> help first -> suggest -> ask one clear question -> remember decisions -> confirm once -> build.
- A useful Goach flow is: understand the user's situation -> explain the likely issue -> suggest a realistic solution -> ask if they want Goach to structure it into a plan -> then collect schedule details.
- Every reply must move one step forward. Do not circle around the same explanation, same offer, or same question.
- For focus/distraction goals, understand why focus is failing before building a routine. Possible areas: phone/social media, noisy environment, unclear task, tiredness, boredom, too many tasks, stress, lack of deadline, poor sleep.
- For the example "I am always distracted, I need to focus" followed by "Work", a good next reply asks what usually distracts them at work or suggests a simple focus-block solution and asks if that direction feels right. A bad next reply asks immediately what time the routine should run.
- Set goalUnderstandingComplete=true only when the core problem and solution direction are clear enough to build a plan.
`;
};

const buildUniversalQuestionPrompts = () => {
  return `
Conversation stages:

Stage 1: Understand the goal
- First understand what the user genuinely wants to achieve.
- If the first message is vague, conversational, or not a real goal, reply naturally and ask what they want to achieve.
- Ask useful goal-specific questions before schedule questions when needed.
- For JAMB preparation, understand relevant details such as target score, subjects, weak areas, current preparation, or exam timeline.
- For workouts, understand the desired result and relevant experience or limitations.
- Early suggestions should guide, not decide for the user. If workout days, study days, duration, intensity, or plan structure are not known yet, use flexible wording like "3 to 5 days usually works well" and ask what fits them.
- If Goach suggests a structure before the user chooses, briefly explain why and ask if it works. Do not lock it until the user accepts.
- If the user gives a clear safe preference, accept it and move forward instead of pushing Goach's earlier suggestion again.
- For business goals, understand the business direction and realistic starting point.
- Ask only questions that materially improve the plan.
- When the goal is clear enough to plan, set goalUnderstandingComplete=true.
- Do not ask selected-day, break-day, level, or session-time questions while goalUnderstandingComplete=false.

Stage 2: Structure the plan
- After goalUnderstandingComplete=true, resolve the required structure.
- Ask only one question at a time.
- Never ask again for a field already resolved in the structured goal draft.
- Never reopen a decision category that is already clear from the conversation or knownFacts. If the user already chose a direction, offer, target, or success target, move forward.
- If the user complains that you are repeating, apologize briefly and either build the plan or ask only the single missing practical detail.
- If several details are already enough for a useful first plan, stop asking and set hasEnoughInfo=true.
- When the user asks for help, guidance, or next steps after you already know the direction, offer, target, and success target, do not ask for those again. Move to the next missing practical detail, or finish the conversation if the plan can be built.
- Treat confirmed answers as locked unless the user clearly changes their answer.

No repeat-question rules:
- If the user answers a question, do not ask the same question again in different words.
- If the user clearly accepts your suggestion by meaning, treat it as acceptance.
- If the user says they already answered or complains that you are repeating, apologize briefly and continue using the stored answer.
- If the reply after a yes/no question or offer is unclear, ask whether they mean yes or no instead of guessing. Do not repeat the same offer.
- If the user asks "what do you suggest", "u suggest", or "suggest", give your best recommendation and move forward unless approval is truly needed.
- Do not reply by asking the same choice again after the user asks you to suggest.
- Do not use "one last thing" more than once in the same goal conversation.

Goal planning type:
- Use meaning, not fixed keywords.
- First decide if the goal is an outcome goal, routine goal, or one-time goal.
- Store this in goalDraft.goalPlanningType.
- Use goalPlanningType="outcome" when the user wants a result, target, score, body change, business result, money result, skill level, or deadline.
- Use goalPlanningType="routine" when the user mainly wants a repeated habit with no clear finish line.
- Use goalPlanningType="one_time" when the user wants to do one clear action once, such as one-time investing, one-time purchase planning, one-time application, one-time setup, or one-time registration.
- For one-time goals, do not ask for weekdays, repeat schedule, session time, breaks, or level unless the user asks for reminders.
- If the user says "just once", "one time", "all at once", "no repeat", or clearly means a single action, lock goalPlanningType="one_time".
- For one-time goals, set durationResolved=true, breaksResolved=true, levelResolved=true.
- For one-time goals, selectedDays may be [], sessionTimes may be [], routineMode may be "custom".
- For one-time goals, ask only for missing details that affect the action itself.
- For outcome goals, do not ask the user how long the goal should take first.
- For outcome goals, recommend the best realistic duration yourself based on the goal, level, schedule, start date, and user context.
- Prefer one clear recommendation instead of making the user choose from a wide range.
- Example: say "I recommend 16 weeks" instead of "12 to 16 weeks" when you have enough context.
- Ask if the user is okay with your recommended duration.
- Store the proposal in estimatedDurationDays and estimatedDurationLabel.
- Set durationResolved=false until the user accepts the proposed duration.
- When the user accepts, set durationResolved=true.
- If the user gives their own duration, check if it is realistic.
- If the user's duration is realistic, accept it and set durationResolved=true.
- If the user's duration is too short or unrealistic, explain why once in simple words and suggest a better duration.
- If the user still insists on the shorter duration and it is safe/legal, respect it.
- When respecting a short or unrealistic duration, do not promise full success.
- Treat it as a short starting phase or aggressive version.
- Say clearly what can realistically happen in that time.
- For routine goals, do not force a full-goal duration.
- For routine goals, confirm the structure instead: goal, time, days, start date, and no end date if that is what the user said.
- When the user confirms the structure of a routine goal, set durationResolved=true.
- Never say "the timeline I suggested" unless you actually suggested a timeline.
- Never promise that the user will achieve the goal with 100% certainty.

Selected days:
- Ask which weekdays should contain shifts unless already resolved.
- Understand phrases such as "Mon to Fri", "weekdays", "weekends", "every day", and reasonable misspellings.
- If the user says every day or daily, set routineMode="everyday" and selectedDays=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].
- Understand exclusions immediately. Example: "every day except Sunday" means selectedDays=["Mon","Tue","Wed","Thu","Fri","Sat"], breakDays=["Sun"], routineMode="custom".
- Once an excluded day is understood, never ask for selected days again unless the user changes their answer.
- Otherwise routineMode must be "custom".
- Never ask for selected days again when selectedDays already contains valid days.
- If the user selects fewer than 7 days, treat the unselected days as break/rest days unless the user says otherwise.
- For workout goals, if the user says "Mon to Fri", set selectedDays=["Mon","Tue","Wed","Thu","Fri"], breakDays=["Sat","Sun"], and breaksResolved=true.
- Do not ask "what are your rest days?" when the selected days already make the rest days obvious.

Goal duration:
- Distinguish active weekdays from the overall goal duration.
- "Every day" without an ending period means an endless routine: routineMode="everyday" and goalEndDate="".
- If the user provides any finite period, date range, deadline, or ending date, set routineMode="custom" even when all 7 weekdays are selected.
- Example: "every day for 3 months" means selectedDays=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], routineMode="custom", and goalEndDate must be the date 3 calendar months after goalStartDate.
- Example: "daily until August 31" means selectedDays contains all 7 weekdays, routineMode="custom", and goalEndDate is the requested end date.
- Store goalStartDate and goalEndDate in YYYY-MM-DD format.
- Use the user's latest duration correction immediately. Do not ask again when the duration is already clear.

Start date:
- Resolve relative date language automatically using the current local date supplied by the server.
- If the user says "today", "tonight", "this night", "start now", "immediately", or "the earlier the better", set goalStartDate to the current local date.
- If the user says "tomorrow", set goalStartDate to the next local calendar date.
- Do not ask the user to type today's date.
- Do not ask the user to format a date as YYYY-MM-DD.
- Ask a start-date question only when the intended date is genuinely unclear.
- Store goalStartDate internally in YYYY-MM-DD format.

Goal duration:
- Distinguish active weekdays from the overall goal duration.
- When the user says "every day" or "daily" without giving a duration, treat it as an open-ended routine unless the goal clearly needs a finite outcome timeline.
- If the user says there is no end date, keep the selectedDays they chose. Use all 7 days only when the user actually wants every day. Set goalEndDate="".
- If the user gives a finite duration, deadline, or end date, set routineMode="custom" even when all 7 weekdays are selected.
- Example: "every day for 3 months" means routineMode="custom", selectedDays=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], and goalEndDate is 3 calendar months after goalStartDate.
- Do not ask about duration again after the user has answered clearly.

Session times:
- Every plan needs at least one preferred session window.
- Store session windows in goalDraft.sessionTimes.
- Each item must contain startTime and endTime in 24-hour HH:mm format.
- Overnight windows are valid. Example: "9:30pm to 5am" becomes {"startTime":"21:30","endTime":"05:00"}.
- For sleep goals, endTime may be earlier than startTime because the session crosses midnight.
- Support multiple sessions on one day.
- Example: "5am - 7am and 16:00 to 18:00" becomes:
  [{"startTime":"05:00","endTime":"07:00"},{"startTime":"16:00","endTime":"18:00"}]
- Never ask for session time again when goalDraft.sessionTimes already contains at least one complete window.
- Resolve session times before resolving the start date.
- Treat confirmed session times as locked.
- Never move a confirmed morning session into the evening or night.

Breaks:
- Resolve selected days first.
- Decide whether breaks matter for the goal.
- If the user rejects a suggested recovery or lighter day, respect the answer, set breaksResolved=true, and do not ask again.
- For light habits where breaks do not matter, set breaksResolved=true without asking.

Level:
- Ask for beginner, intermediate, or advanced only when relevant.
- If level is irrelevant, set levelResolved=true without asking.
- Never ask again when levelResolved=true.

Coach judgment:
- If a request seems harmful, unrealistic, or counterproductive, explain why politely and suggest a better option once.
- Respect the user's answer if it remains safe and legal.
- Refuse illegal or dangerous requests and offer a safe alternative.
`;
};


const makeSearchUrl = (base, query) => {
  return `${base}${encodeURIComponent(query)}`;
};

const normalizeResourceLinks = (links = []) => {
  if (!Array.isArray(links)) return [];

  return links
    .map((link) => ({
      title: String(link?.title ?? "").trim(),
      query: String(link?.query ?? "").trim(),
      type: String(link?.type ?? "search").trim(),
    }))
    .filter((link) => link.title && link.query)
    .slice(0, 3)
    .map((link) => {
      if (link.type === "video") {
        return {
          title: link.title,
          url: makeSearchUrl(
            "https://www.youtube.com/results?search_query=",
            link.query,
          ),
        };
      }

      if (link.type === "image") {
        return {
          title: link.title,
          url: makeSearchUrl(
            "https://www.google.com/search?tbm=isch&q=",
            link.query,
          ),
        };
      }

      return {
        title: link.title,
        url: makeSearchUrl("https://www.google.com/search?q=", link.query),
      };
    });
};



const enrichPlanItems = async (
  planItems,
  goal,
  includeImages,
  adjustPastTodayShifts = true,
) => {
  const now = new Date();

 const safePlan = adjustPastTodayShifts
  ? planItems.map((item) => {
      const targetType = String(item?.targetType ?? "weekday");

      // Recurring weekday templates must keep the user's confirmed time.
      // If today's occurrence has passed, the next matching day will use it.
      if (targetType === "weekday") {
        return item;
      }

      return ensureFutureForToday(item, now);
    })
  : planItems;
  const nonOverlappingPlan = removeOverlappingShifts(safePlan);

  return Promise.all(
    nonOverlappingPlan.map(async (item) => {
      const title = String(item?.title ?? "AI Shift").trim();
      const startTime = String(item?.startTime ?? "18:00").trim();
      const endTime = String(item?.endTime ?? "19:00").trim();
      let explanation = String(
        item?.explanation ?? "Complete this shift as planned.",
      ).trim();

      // Improve readability (turn sentences into step-like lines)
      explanation = explanation
        .replace(/\.\s+/g, "\n")
        .replace(/Ã¢â‚¬Â¢/g, "")
        .trim();
      const category =
        String(item?.category ?? "").trim() ||
        inferCategoryFromText(title, goal);

      const imageSearchQuery =
        String(item?.imageSearchQuery ?? "").trim() ||
        buildImageSearchQuery({
          title,
          goal,
          category,
        });
      const preservedImageKey = item?.imageKey
        ? String(item.imageKey).trim()
        : undefined;

      const preservedImageUri = item?.imageUri
        ? String(item.imageUri).trim()
        : null;

      let unsplashData = null;

      if (includeImages && !preservedImageKey && !preservedImageUri) {
        try {
          unsplashData = await searchUnsplashPhoto(imageSearchQuery);

          if (unsplashData?.imageDownloadLocation) {
            triggerUnsplashDownload(unsplashData.imageDownloadLocation);
          }
        } catch (imageError) {
          console.log(
            `Unsplash lookup failed for "${imageSearchQuery}":`,
            imageError.message,
          );
        }
      }

      return {
        id: item?.id ? String(item.id).trim() : undefined,
        title,
        weekdayLabel: item?.weekdayLabel
          ? String(item.weekdayLabel).trim()
          : undefined,
        startTime,
        endTime,
        explanation,
        category,
        imageSearchQuery,

        timeframeType: String(item?.timeframeType ?? "day").trim(),
        timeframeValue: Number(item?.timeframeValue ?? 1),
        targetType: String(item?.targetType ?? "weekday").trim(),
        targetKey: item?.targetKey ? String(item.targetKey).trim() : undefined,
        targetLabel: item?.targetLabel
          ? String(item.targetLabel).trim()
          : undefined,
        plannedDate: item?.plannedDate
          ? String(item.plannedDate).trim()
          : undefined,
        phaseLabel: item?.phaseLabel
          ? String(item.phaseLabel).trim()
          : undefined,
        difficultyLevel: item?.difficultyLevel
          ? String(item.difficultyLevel).trim()
          : undefined,
        resourceLinks: normalizeResourceLinks(item?.resourceLinks),


imageKey: preservedImageKey,
imageUri:
  preservedImageUri || (includeImages ? unsplashData?.imageUri || null : null),
imageThumbUri:
  item?.imageThumbUri || (includeImages ? unsplashData?.imageThumbUri || null : null),
unsplashPhotoId:
  item?.unsplashPhotoId || (includeImages ? unsplashData?.unsplashPhotoId || null : null),
imageAuthor:
  item?.imageAuthor || (includeImages ? unsplashData?.imageAuthor || null : null),
imageAuthorUsername:
  item?.imageAuthorUsername ||
  (includeImages ? unsplashData?.imageAuthorUsername || null : null),
imageAuthorUrl:
  item?.imageAuthorUrl || (includeImages ? unsplashData?.imageAuthorUrl || null : null),
imageUnsplashUrl:
  item?.imageUnsplashUrl ||
  (includeImages ? unsplashData?.imageUnsplashUrl || null : null),
      };
    }),
  );
};

const getAgeFromDateOfBirth = (dateOfBirth) => {
  if (!dateOfBirth) return null;

  const birthDate = new Date(dateOfBirth);
  if (Number.isNaN(birthDate.getTime())) return null;

  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();

  if (
    monthDiff < 0 ||
    (monthDiff === 0 && today.getDate() < birthDate.getDate())
  ) {
    age -= 1;
  }

  return age >= 0 && age <= 120 ? age : null;
};

const getUserCoachContext = async (userId) => {
  if (!supabaseAdmin || !userId) {
    return "No user profile context available.";
  }

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("first_name, middle_name, last_name, gender, country, date_of_birth")
    .eq("id", userId)
    .single();

  if (error || !data) {
    return "No user profile context available.";
  }

  const firstName = String(data.first_name ?? "").trim();
const middleName = String(data.middle_name ?? "").trim();
const lastName = String(data.last_name ?? "").trim();
const gender = String(data.gender ?? "").trim();
const country = String(data.country ?? "").trim();
const age = getAgeFromDateOfBirth(data.date_of_birth);

return `
Preferred name: ${firstName || "Not provided"}
Full name parts: ${[firstName, middleName, lastName].filter(Boolean).join(" ") || "Not provided"}
Age: ${age ?? "Not provided"}
Gender: ${gender || "Not provided"}
Country: ${country || "Not provided"}



Use this profile context carefully:
- Use the preferred name occasionally, only when it sounds natural
- If no preferred name is provided, do not use username; speak normally
- Use age to adjust realism, intensity, safety, and planning style
- Use gender only when it is directly relevant to the goal
- Use country as helpful default context for currency, school systems, food, local terms, work culture, and realistic planning
- Do not restrict the plan to the user's country if the user's goal clearly needs a wider or different context
- Do not stereotype the user
- Do not assume appearance, body type, fitness level, strength, health, or personality from gender or age alone
`.trim();
};

/* -------------------------------- ROUTES ------------------------------- */

app.get("/", (req, res) => {
  res.send("AI backend is running");
});

app.post("/auth/request-password-reset", async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({
        error: "Supabase service role is not configured",
      });
    }

    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({
        error: "Email is required",
      });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("id, email")
      .eq("email", email)
      .single();

    // Do not reveal whether an email exists.
    if (profileError || !profile) {
      return res.json({
        ok: true,
        message: "If that email exists, a reset code has been sent.",
      });
    }

    const code = createResetCode();
    const expiresAt = Date.now() + 10 * 60 * 1000;

    passwordResetCodes.set(email, {
      code,
      userId: profile.id,
      expiresAt,
      attempts: 0,
    });

    await sendResetEmail({ email, code });

    res.json({
      ok: true,
      message: "If that email exists, a reset code has been sent.",
      devCode: RESEND_API_KEY ? undefined : code,
    });
  } catch (error) {
    console.log("REQUEST PASSWORD RESET ERROR:", error);
    res.status(500).json({
      error: error?.message || "Failed to request password reset",
    });
  }
});

app.post("/auth/confirm-password-reset", async (req, res) => {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({
        error: "Supabase service role is not configured",
      });
    }

    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code ?? "").trim();
    const newPassword = String(req.body?.newPassword ?? "");

    if (!email || !code || !newPassword) {
      return res.status(400).json({
        error: "Email, code, and new password are required",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters",
      });
    }

    const saved = passwordResetCodes.get(email);

    if (!saved) {
      return res.status(400).json({
        error: "Invalid or expired reset code",
      });
    }

    if (Date.now() > saved.expiresAt) {
      passwordResetCodes.delete(email);
      return res.status(400).json({
        error: "Reset code has expired",
      });
    }

    if (saved.attempts >= 5) {
      passwordResetCodes.delete(email);
      return res.status(429).json({
        error: "Too many attempts. Request a new code.",
      });
    }

    if (saved.code !== code) {
      saved.attempts += 1;
      passwordResetCodes.set(email, saved);

      return res.status(400).json({
        error: "Invalid reset code",
      });
    }

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      saved.userId,
      {
        password: newPassword,
      },
    );

    if (updateError) {
      throw updateError;
    }

    passwordResetCodes.delete(email);

    res.json({
      ok: true,
      message: "Password updated successfully",
    });
  } catch (error) {
    console.log("CONFIRM PASSWORD RESET ERROR:", error);
    res.status(500).json({
      error: error?.message || "Failed to reset password",
    });
  }
});

app.post("/billing/paystack-webhook", async (req, res) => {
  try {
    if (!verifyPaystackWebhookSignature(req)) {
      return res.status(401).json({ error: "Invalid Paystack signature" });
    }

    const event = req.body;
    const eventName = event?.event;
    const data = event?.data || {};

    if (eventName === "charge.success") {
      const purpose = data?.metadata?.purpose;
      const result =
        purpose === "goach_credit_pack"
          ? await applyPaystackCreditPackPayment(data)
          : await applyPaystackPlanPayment(data);
      return res.json({ ok: true, result });
    }

    if (eventName === "invoice.payment_success") {
      const result = await applyPaystackPlanPayment(data);
      return res.json({ ok: true, result });
    }

    if (eventName === "subscription.disable") {
      const result = await disablePaystackSubscription(data);
      return res.json({ ok: true, result });
    }

    return res.json({ ok: true, ignored: true });
  } catch (error) {
    console.log("PAYSTACK WEBHOOK ERROR:", error);
    res.status(500).json({
      error: error?.message || "Failed to process Paystack webhook",
    });
  }
});

const startCreditPackCheckoutHandler = async (req, res) => {
  try {
    requireBillingConfig();

    const { userId, email, packId, amount, baseAmount, credits } = req.body;
    const creditPack = getCreditPack(packId);

    if (!userId || !email) {
      return res.status(400).json({ error: "User ID and email are required" });
    }

    if (!creditPack) {
      return res.status(400).json({ error: "Invalid credit pack selected" });
    }

    if (Number(baseAmount) !== creditPack.baseAmount) {
      return res.status(400).json({ error: "Credit pack amount does not match server pricing" });
    }

    if (Number(credits) !== creditPack.credits) {
      return res.status(400).json({ error: "Credit pack credits do not match server pricing" });
    }

    if (!Number.isFinite(Number(amount)) || Number(amount) < creditPack.baseAmount) {
      return res.status(400).json({ error: "Invalid checkout amount" });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("id, email, plan, subscription_status")
      .eq("id", userId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    if (!isActivePaidProfile(profile)) {
      return res.status(403).json({
        error: "Choose a monthly plan before buying extra Goach credits",
      });
    }

    const reference = `credits_${creditPack.credits}_${userId}_${Date.now()}`;

    const paystackData = await paystackRequest("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email,
        amount: String(Math.round(Number(amount) * 100)),
        currency: "NGN",
        reference,
        channels: ["card"],
        callback_url: `${APP_BILLING_CALLBACK_URL}?reference=${reference}`,
        metadata: {
          userId,
          packId: creditPack.id,
          packName: creditPack.name,
          credits: creditPack.credits,
          baseAmount: creditPack.baseAmount,
          payableAmount: Number(amount),
          purpose: "goach_credit_pack",
        },
      }),
    });

    res.json({
      authorizationUrl: paystackData.data.authorization_url,
      accessCode: paystackData.data.access_code,
      reference: paystackData.data.reference,
    });
  } catch (error) {
    console.log("START CREDIT PACK CHECKOUT ERROR:", error);
    res.status(500).json({
      error: error?.message || "Failed to start credit pack checkout",
    });
  }
};

const verifyCreditPackCheckoutHandler = async (req, res) => {
  try {
    requireBillingConfig();

    const { userId, reference } = req.body;

    if (!userId || !reference) {
      return res.status(400).json({
        error: "User ID and transaction reference are required",
      });
    }

    const verification = await paystackRequest(
      `/transaction/verify/${encodeURIComponent(reference)}`,
      { method: "GET" },
    );

    const transaction = verification.data;

    if (transaction.status !== "success") {
      return res.status(400).json({ error: "Payment was not successful" });
    }

    if (transaction.metadata?.userId && transaction.metadata.userId !== userId) {
      return res.status(403).json({ error: "Transaction does not belong to this user" });
    }

    if (transaction.metadata?.purpose !== "goach_credit_pack") {
      return res.status(400).json({ error: "Transaction is not a Goach credit pack" });
    }

    const result = await applyPaystackCreditPackPayment(transaction);

    if (!result.applied) {
      if (result.reason === "already_applied") {
        return res.json({ ok: true, alreadyApplied: true });
      }

      return res.status(400).json({
        error: result.reason || "Unable to apply credit pack",
      });
    }

    res.json({
      ok: true,
      addedCredits: result.addedCredits,
      remainingCredits: result.remainingCredits,
    });
  } catch (error) {
    console.log("VERIFY CREDIT PACK CHECKOUT ERROR:", error);
    res.status(500).json({
      error: error?.message || "Failed to verify credit pack checkout",
    });
  }
};

app.post("/billing/start-credit-pack", startCreditPackCheckoutHandler);
app.post("/billing/verify-credit-pack", verifyCreditPackCheckoutHandler);

const schedulePlanChangeHandler = async (req, res) => {
  try {
    requireBillingConfig();

    const { userId, planId } = req.body;
    const billingPlan = getBillingPlan(planId);

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    if (!billingPlan) {
      return res.status(400).json({ error: "Invalid billing plan selected" });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("id, plan, subscription_status, current_period_ends_at, subscription_id, subscription_email_token")
      .eq("id", userId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    if (!["mini", "standard", "premium"].includes(profile.plan)) {
      return res.status(400).json({
        error: "Choose a plan first before scheduling a plan change",
      });
    }

    if (profile.subscription_status !== "active") {
      return res.status(400).json({
        error: "Only active paid plans can schedule a plan change",
      });
    }

    if (profile.plan === billingPlan.id) {
      return res.status(400).json({
        error: "This account is already on this plan",
      });
    }

    const startsAt = profile.current_period_ends_at
      ? new Date(profile.current_period_ends_at)
      : addDays(new Date(), 30);

    const disableResult = await disablePaystackSubscriptionByCode(
      profile.subscription_id,
      profile.subscription_email_token,
    );

    const { error: updateError } = await supabaseAdmin
      .from("profiles")
      .update({
        pending_plan: billingPlan.id,
        pending_plan_starts_at: startsAt.toISOString(),
        cancel_at_period_end: true,
      })
      .eq("id", userId);

    if (updateError) {
      throw updateError;
    }

    res.json({
      ok: true,
      pendingPlan: billingPlan.id,
      pendingPlanName: billingPlan.name,
      pendingPlanStartsAt: startsAt.toISOString(),
    });
  } catch (error) {
    console.log("SCHEDULE PLAN CHANGE ERROR:", error);
    res.status(500).json({
      error: error?.message || "Failed to schedule plan change",
    });
  }
};

app.post("/billing/schedule-plan-change", schedulePlanChangeHandler);

const startPlanCheckoutHandler = async (req, res) => {
  try {
    requireBillingConfig();

    const { userId, email, planId, amount, baseAmount, credits } = req.body;
    const billingPlan = getBillingPlan(planId);

    if (!userId || !email) {
      return res.status(400).json({
        error: "User ID and email are required",
      });
    }

    if (!billingPlan) {
      return res.status(400).json({
        error: "Invalid billing plan selected",
      });
    }

    if (Number(baseAmount) !== billingPlan.baseAmount) {
      return res.status(400).json({
        error: "Plan amount does not match server pricing",
      });
    }

    if (Number(credits) !== billingPlan.credits) {
      return res.status(400).json({
        error: "Plan credits do not match server pricing",
      });
    }

    if (!Number.isFinite(Number(amount)) || Number(amount) < billingPlan.baseAmount) {
      return res.status(400).json({
        error: "Invalid checkout amount",
      });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("id, email, plan, subscription_status")
      .eq("id", userId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({
        error: "Profile not found",
      });
    }

    if (profile.subscription_status === "active" && profile.plan === billingPlan.id) {
      return res.status(400).json({
        error: "This account is already on this plan",
      });
    }

    const reference = `plan_${billingPlan.id}_${userId}_${Date.now()}`;

    const paystackData = await paystackRequest("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email,
        amount: String(Math.round(Number(amount) * 100)),
        currency: "NGN",
        reference,
        channels: ["card"],
        callback_url: `${APP_BILLING_CALLBACK_URL}?reference=${reference}`,
        metadata: {
          userId,
          planId: billingPlan.id,
          planName: billingPlan.name,
          credits: billingPlan.credits,
          baseAmount: billingPlan.baseAmount,
          payableAmount: Number(amount),
          purpose: "goach_plan_subscription",
        },
      }),
    });

    res.json({
      authorizationUrl: paystackData.data.authorization_url,
      accessCode: paystackData.data.access_code,
      reference: paystackData.data.reference,
    });
  } catch (error) {
    console.log("START PLAN CHECKOUT ERROR:", error);
    res.status(500).json({
      error: error?.message || "Failed to start plan checkout",
    });
  }
};

app.post("/billing/start-plan", startPlanCheckoutHandler);
app.post("/billing/start-trial", startPlanCheckoutHandler);

const verifyPlanCheckoutHandler = async (req, res) => {
  try {
    requireBillingConfig();

    const { userId, reference } = req.body;

    if (!userId || !reference) {
      return res.status(400).json({
        error: "User ID and transaction reference are required",
      });
    }

    const verification = await paystackRequest(
      `/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: "GET",
      },
    );

    const transaction = verification.data;

    if (transaction.status !== "success") {
      return res.status(400).json({
        error: "Payment was not successful",
      });
    }

    const metadataUserId = transaction.metadata?.userId;
    const billingPlan = getBillingPlan(transaction.metadata?.planId);

    if (metadataUserId && metadataUserId !== userId) {
      return res.status(403).json({
        error: "Transaction does not belong to this user",
      });
    }

    if (!billingPlan) {
      return res.status(400).json({
        error: "Transaction does not contain a valid plan",
      });
    }

    const authorizationCode = transaction.authorization?.authorization_code;
    const customerCode = transaction.customer?.customer_code;
    const billingEmail = transaction.customer?.email;
    const now = new Date();
    const currentPeriodEndsAt = addDays(now, 30);
    let subscriptionCode = null;
    let subscriptionEmailToken = null;

    if (authorizationCode && customerCode && billingPlan.paystackPlanCode) {
      const subscription = await paystackRequest("/subscription", {
        method: "POST",
        body: JSON.stringify({
          customer: customerCode,
          plan: billingPlan.paystackPlanCode,
          authorization: authorizationCode,
        }),
      });

      subscriptionCode =
        subscription.data?.subscription_code || subscription.data?.id || null;
      subscriptionEmailToken = subscription.data?.email_token || null;
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("ai_credits")
      .eq("id", userId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({
        error: "Profile not found",
      });
    }

    const existingCredits = Number(profile.ai_credits ?? 0);
    const nextCredits = Math.max(0, existingCredits) + billingPlan.credits;

    const { error: updateError } = await supabaseAdmin
      .from("profiles")
      .update({
        plan: billingPlan.id,
        ai_credits: nextCredits,
        trial_used: true,
        trial_started_at: null,
        trial_ends_at: null,
        subscription_status: "active",
        subscription_provider: "paystack",
        subscription_id: subscriptionCode,
        subscription_email_token: subscriptionEmailToken,
        customer_id: customerCode,
        payment_authorization_code: authorizationCode ?? null,
        payment_reference: reference,
        billing_email: billingEmail,
        cancel_at_period_end: false,
        current_period_ends_at: currentPeriodEndsAt.toISOString(),
        pending_plan: null,
        pending_plan_starts_at: null,
      })
      .eq("id", userId);

    if (updateError) {
      throw updateError;
    }

    const creditUser = await getOrCreateCreditUser(userId, billingPlan.id);
    creditUser.credits = nextCredits;
    creditUser.plan = billingPlan.id;

    res.json({
      ok: true,
      plan: billingPlan.id,
      subscriptionStatus: "active",
      currentPeriodEndsAt: currentPeriodEndsAt.toISOString(),
      remainingCredits: nextCredits,
    });
  } catch (error) {
    console.log("VERIFY PLAN CHECKOUT ERROR:", error);
    res.status(500).json({
      error: error?.message || "Failed to verify plan checkout",
    });
  }
};

app.post("/billing/verify-plan", verifyPlanCheckoutHandler);
app.post("/billing/verify-trial", verifyPlanCheckoutHandler);

app.post("/tester/activate", (req, res) => {
  const { password } = req.body;

  if (!TESTER_PASSWORD) {
    return res.status(500).json({
      error: "Tester password is not configured on the server",
    });
  }

  if (!password || String(password) !== TESTER_PASSWORD) {
    return res.status(401).json({
      error: "Invalid tester password",
    });
  }

  res.json({
  ok: true,
  plan: "premium",
  aiCredits: CREDIT_RULES.premium.initialCredits,
});
});


app.get("/credits/status", async (req, res) => {
  const userId = req.headers["x-user-id"];
  const userPlan = req.headers["x-user-plan"] || "free";
  const userEmail = req.headers["x-user-email"] || req.headers["x-email"] || "";

  if (!userId) {
    return res.status(401).json({ error: "User ID required" });
  }

  if (isUnlimitedCreditUser(userId, userEmail)) {
    return res.json({
      remainingCredits: UNLIMITED_CREDIT_BALANCE,
      plan: "tester",
      unlimitedCredits: true,
    });
  }

  const user = await getOrCreateCreditUser(userId, userPlan);

  res.json({
    remainingCredits: user.credits,
    plan: user.plan,
  });
});


app.post("/generate-next-question", checkCredits, async (req, res) => {
  try {
    const {
      goal,
      messages = [],
      existingSchedule = [],
      currentGoalMeta = null,
    } = req.body;

    if (!goal || !String(goal).trim()) {
      return res.status(400).json({ error: "Goal is required" });
    }

    const now = new Date();
    const currentDateTimeContext = formatLocalDateTimeContext(now);
    const userCoachContext = await getUserCoachContext(req.userId);
    const existingScheduleText = formatExistingScheduleForAI(existingSchedule);
    const existingBusyTimesMemory = buildExistingBusyTimesMemory(existingSchedule);
    const startDateRecommendationForPrompt =
      !String(currentGoalMeta?.goalStartDate ?? "").trim()
        ? resolveGoalStartDateRecommendation(currentGoalMeta, now)
        : null;

    const latestUserMessage = getLatestMessageByRole(messages, "user") || String(goal).trim();
    const previousAssistantReply = getLatestMessageByRole(messages, "assistant");
    const latestUserAskedDirectQuestion = isDirectClarificationQuestion(latestUserMessage);
    const userComplainedAboutRepeat = /\b(already answered|already told|you repeated|repeating|repeat|i told you|we have done|done this before|asked me already|same question)\b/i.test(latestUserMessage);
    const previousAssistantWasSummary =
      /here is the plan i am about to build/i.test(previousAssistantReply) ||
      /\b(summary|plan|goal|routine|workout|meal|study)\b[\s\S]{0,240}does (that|this) look right\?/i.test(previousAssistantReply);
    const previousAssistantAskedForApproval = /\b(does that work|does this work|does that look right|is that ok|is this ok|are you okay with that|should i use that|can i use that)\b/i.test(
      previousAssistantReply,
    );
    const userAcceptedSummary = previousAssistantWasSummary && isLikelyAcceptanceReply(latestUserMessage);
    const userAcceptedPendingSuggestion =
      !previousAssistantWasSummary &&
      previousAssistantAskedForApproval &&
      isLikelyAcceptanceReply(latestUserMessage);
    const recentMessages = Array.isArray(messages) ? messages.slice(-16) : [];
    const assistantReplyCount = Array.isArray(messages)
      ? messages.filter((item) => item?.role === "assistant").length
      : 0;

    const conversationText = recentMessages.length > 0
      ? recentMessages
          .map((item, index) => {
            const role = String(item?.role ?? "user").toUpperCase();
            const content = String(item?.content ?? "").trim();
            return `${index + 1}. ${role}: ${content}`;
          })
          .join("\n")
      : "No follow-up conversation yet.";

    const currentDraft = normalizeGoalForm({
      goalMeta: currentGoalMeta ?? {},
      fallbackGoal: goal,
    });

    const previousAssistantNeedsConfirmation = previousAssistantNeedsYesNoAnswer(previousAssistantReply);
    const latestConfirmationIntent = classifyConfirmationReply(latestUserMessage);
    const latestUserWantsNoMoreQuestions = userWantsNoMoreQuestions(latestUserMessage);
    const coachMode = inferCoachMode({
      latestUserMessage,
      currentDraft,
      previousAssistantReply,
    });
    const userAcceptedGoalCardOffer =
      previousAssistantAskedForGoalCard(previousAssistantReply) && latestConfirmationIntent === "accept";
    const userExplicitlyRequestedScheduledGoal = userExplicitlyWantsScheduledGoal(latestUserMessage);
    const latestUserRequestedAdviceOnly = userWantsAdviceOnly(latestUserMessage);
    const userRequestedActionPlan =
      !latestUserRequestedAdviceOnly &&
      (
        userWantsPlanGuide(latestUserMessage, currentDraft.memorySummary, currentDraft.coreProblem, currentDraft.suggestedSolution) ||
        normalizeResponseMode(currentDraft.responseMode) === "plan_guide"
      );
    const userAcceptedPlanGuideOffer =
      /\b(plan guide|guide with actions|actions you can follow|turn it into.*guide)\b/i.test(previousAssistantReply) &&
      latestConfirmationIntent === "accept" &&
      !latestUserRequestedAdviceOnly &&
      !userExplicitlyRequestedScheduledGoal;
    const actionPlanShouldBecomeGoalCard = userRequestedActionPlan || userAcceptedPlanGuideOffer;
    const planGuideMode = false;
    const shouldOfferPlanGuide = shouldOfferPlanGuideFromAdvice({
      latestUserMessage,
      previousAssistantReply,
      currentDraft,
    });
    const foodGuideOnlyMode = !actionPlanShouldBecomeGoalCard && isFoodGuideOnlyConversation(
      goal,
      conversationText,
      latestUserMessage,
      currentDraft.memorySummary,
      currentDraft.coreProblem,
      currentDraft.suggestedSolution,
    );
    const pendingSessionDurationMinutes = parseSessionDurationMinutesFromText(latestUserMessage);
    const pendingSessionTimes = normalizeGoalSessionTimes(
      currentDraft.pendingSuggestion?.sessionTimes,
      currentDraft.pendingSuggestion?.sessionTime,
    );
    const userAdjustedPendingSessionDuration =
      !previousAssistantWasSummary &&
      pendingSessionDurationMinutes > 0 &&
      pendingSessionTimes.length > 0;

    const shouldLetGoachInterpretReply =
      previousAssistantNeedsConfirmation &&
      latestConfirmationIntent === "unclear" &&
      !userAdjustedPendingSessionDuration &&
      !messageLooksLikeConcreteAnswer(latestUserMessage) &&
      !latestUserAskedDirectQuestion &&
      !userComplainedAboutRepeat;

    const response = await client.chat.completions.create({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "system",
          content: `
You are Goach, an AI goal coach powered by OpenAI inside a goal-planning app.

Your job is not to collect form fields. Your job is to understand the user, guide them clearly, then help turn anything they want to follow into a realistic goal-card plan.

Voice:
${buildSimpleCoachVoiceRules()}

Core behavior:
- Reply like a calm, smart human coach, not like a form or database.
- Keep replies short: 1 to 3 short sentences most of the time.
- Ask at most one question, but ask it naturally. There are many ways to get information from the user; do not always use the same wording.
- Most replies should end by leading the user to the next step with one natural question. Do not end with a dead statement when the conversation still needs a next move.
- Avoid strict yes/no clarification. If the user's meaning can be understood as a choice, correction, time, date, day, acceptance, rejection, or direct question, respond to that meaning. Only clarify when the message truly gives no usable direction.
- Before sending any reply, silently check: Did I understand? Did I answer the user's real need? Am I repeating? Am I asking for something already known? Is this the one next useful question?
- When it saves time, ask one bundled high-value question instead of many tiny questions. Example shape: "What are the main parts, and which part is weakest?" Do this by meaning, not by fixed keywords.
- Never ask the same meaning twice.
- Before asking, check the conversation, memorySummary, lockedDecisions, knownFacts, selectedDays, sessionTimes, duration, level, and start date.
- If something is already answered, use it. Do not confirm it again unless the user changed it.
- If the user asks a direct question or says they do not understand, answer that first.
- If the user says "u suggest", "you choose", "I do not know", or similar, recommend a realistic option instead of pushing the question back to them.
- Early suggestions are guidance, not decisions. When the goal direction is still unclear, use flexible range language like "3 to 5 days usually works well" instead of deciding "I suggest a 3-day plan".
- If you suggest days, duration, intensity, or plan structure before the user has chosen, briefly say why and ask if that direction works.
- When the user gives a clear preference that is safe and realistic, accept it and move forward. Do not keep pushing your earlier suggestion.
- Think by goal type, not by fixed scripts. First understand whether this is study/exam, health/food, fitness/body, business/money, skill learning, confidence/behavior, routine/habit, or one-time task. Use that type only to know what details matter.
- Short replies like "ok", "sure", "yes", "please", and "alright" mean different things based on context. If you just gave advice or made an offer, treat them as "continue with the offer". If you asked a clear yes/no question, treat them as yes. If you showed a full final summary, treat them as final confirmation.
- Do not treat "ok" or "sure" as permission to finish unless a full final summary was already shown. If the previous message suggested a next step, "ok" means continue with that next step.
- Do not use confusing planning words like "time window", "duration", "frequency", "timeline", or "structure" without explaining them simply. Prefer warm, clear wording like "What time should we use for it?". For how long a goal should run, suggest a realistic length yourself first instead of pushing the choice back to the user.
- Do not use broken encoding artifacts. Use normal ASCII apostrophes or simple words.
- Understand Nigerian greetings in general, including Pidgin and casual forms like "how far", "howfar", "how u dey", "how you dey", "how now", "wetin dey", and "how body" as greetings, not goal titles.

Memory system:
- memorySummary is your short private summary of what the user wants and what has been decided.
- lockedDecisions are confirmed facts you must not ask again.
- openQuestions are the few missing details that still matter.
- Keep memorySummary under 80 words.
- Keep lockedDecisions short and universal. Example: "focus: group public speaking", "days: Mon to Fri", "time: 2:00pm to 2:15pm".
- If memorySummary and lockedDecisions conflict, the latest user message wins.
- If the user accepts a pendingSuggestion with ok, yes, sure, alright, or similar, move that suggestion into the real goalDraft fields and lockedDecisions. Then clear pendingSuggestion.

Goach response order:
1. Listen: read the latest user message and the conversation memory before deciding anything.
2. Understand: identify what the user is trying to do, fix, feel, learn, or ask.
3. Help first: answer direct questions and give useful advice before asking schedule details.
4. Suggest: if the user is unsure, recommend a realistic next step and briefly say why.
5. Ask one clear question: ask only the next important question that moves the chat forward.
6. Remember: never ask again for a decision already in memorySummary, lockedDecisions, knownFacts, selectedDays, sessionTimes, duration, level, start date, or the latest user message.
7. Confirm once: when the plan is clear, show one clean final summary and ask if it looks right.
8. Build: after the user confirms that full summary, set hasEnoughInfo=true and reply only: "Your plan is ready to build now."

Conversation flow:
1. Understand: identify what the user really wants or struggles with.
2. Guide: give a simple useful suggestion or explain the situation.
3. Structure: recommend days, time, duration, breaks, or level only after the goal direction is clear.
4. Summary: when enough is known, give one full summary and ask if it looks right.
5. Ready: after the user confirms the full summary, set hasEnoughInfo=true and reply only: "Your plan is ready to build now."

Mode rules:
- Coach Mode is for users who do not have a plan yet, are struggling, or are asking how to improve. In Coach Mode, understand first, help simply, suggest a realistic path, then ask one useful next question.
- Advice is not a locked mode. If the user asks a simple question, answer it simply and naturally. Do not force a goal card from a pure explanation.
- If the user asks for something to follow, like a routine, plan, guide, actions, steps, meal guide, workout plan, study routine, or habit routine, treat it as Goal Card Mode automatically. Do not ask whether to make it a guide first.
- Goal Card Mode is for tracked plans in the app. Collect the needed details naturally: days, time, start date, duration or no end date, shifts, and final summary.
- Quick Build Mode is for users who clearly want a goal card, shift, routine, reminder, or plan made quickly. In Quick Build Mode, extract what they already gave, ask only the one missing required detail, then summarize.
- If backend controller state says planGuideMode=true, treat it as a legacy signal for Goal Card Mode unless the user clearly said advice only or no goal card.
- If backend controller state says shouldOfferPlanGuide=true, do not offer a chat-only guide. Move toward the right next goal-card detail.
- If backend controller state says coachMode="quick_build", do not drift back into advice-only mode unless the user clearly changes their mind.
- If backend controller state says userAcceptedGoalCardOffer=true, the goal-card decision is already locked. Never ask again whether to make it a goal card.
- If backend controller state says latestUserWantsNoMoreQuestions=true, stop optional discovery. Use what is known, suggest a sensible default when safe, or ask only the one detail the app truly needs.
- If backend controller state says foodGuideOnlyMode=true, answer the food question directly because the user did not ask for a routine, plan, guide, or something to follow.
- Do not use "Does this look right?" for a rough idea, preview, advice, or partial plan. Use it only for the one final summary when all required details are known.
- If the user already answered days, time, duration, start date, level, or goal direction, do not ask that same detail again.
- Understand day ranges from human typing: "Mon-Fri", "Mon to Fri", "Mon;Fri", and "Monday-Friday" mean Mon, Tue, Wed, Thu, Fri. "Only Friday" means Friday only.
- For scheduled routines and goal cards, never show the final summary until the time is known. Ask for time first.
- If the user gives only a start time, suggest a reasonable end time but do not lock it until the user accepts. Example: "I suggest 5:00pm to 6:00pm. Does that work?"
- If the user gives multiple times in one reply, such as morning 5am, afternoon 3pm, and night 7pm, treat them as separate sessions. Do not keep only the first time.
- When multiple loose start times are given without end times, ask one clear question for all of them. Example: "I have 5am, 3pm, and 7pm. Should each session be 1 hour?"
- If the user gives multiple exact ranges, keep all ranges and include all of them in the final summary.
- Sleep and wake-up routines are special. A bedtime and wake time are not normal one-hour sessions. Treat them as bedtime/wake reminders, or as a sleep routine, and ask only the next missing detail such as days or start date.
- If the user corrects a final summary, update the corrected detail and show a clean corrected summary. Do not ask whether they mean yes or no.
- If the user asks why a date, time, or day was chosen, answer the question first and correct the draft if it was wrong.
- For outcome goals like muscle gain, fat loss, exam scores, skill learning, confidence, or business growth, recommend a realistic duration and get approval before final summary. Do not silently use "no end date".

Goal-card rules:
- Do not show "Here is the plan I am about to build" until the user clearly wants something to follow and the needed details are known.
- If the user is only asking advice or explanation, answer normally in chat.
- If the user wants Goach to create/build/add/save/lock the plan, use goal_planning or quick_build mode.
- If a user asks for a plan guide, full plan, quick plan, routine, or steps they can follow, build toward a goal card automatically. Do not keep asking whether to turn it into a guide.
- If the plan has multiple parts, cover all important parts inside the goal card plan. Example: a weight-loss plan with meals and walking must include both meals and walking.
- For food routine or meal-plan intent, after the user agrees to continue, do not explain balanced meals again. Ask the next missing goal-card detail instead: one day/one week/one month, Nigerian foods or general foods, meal times or loose guide, simple or strict, then schedule details if needed.
- If the user already gave length, food style, aim, loose/strict choice, and meals/snacks, move to the missing app detail such as time/start date, or show the final summary if complete. Do not keep saying "I can".
- "Full week" means all 7 days. Do not ask one day/week/month again.
- For balanced diet advice, explain the balanced plate only once unless the user asks again. After that, move to the next clear question.
- For body, fitness, food, energy, or health-related goals, reason from the user's actual intent before asking schedule questions.
- Do not force gym/home/training questions just because the user mentions health, energy, light movement, stretching, walking, or a healthy routine.
- If the user wants body transformation, such as muscle gain, weight loss, bulking, strength, shape, or physique, first understand the result they want in plain words.
- If training setup clearly matters for that result, ask naturally about home, gym, both, or equipment. If the goal is wellness, energy, sleep, water, or light habits, ask about the simple habit routine instead.
- If muscle gain is clearly involved, explain simply that the plan needs training, enough food, and rest. Do not reduce it to only food reminders.
- Before final summary, make sure each reminder has a clear purpose, such as workout, meal, walk, stretch, water, sleep, food prep, weigh-in, or check-in.
- For routines/outcome goals that need scheduled shifts, collect selected days, session time, start date, and duration/no end date.
- Build-ready minimum for scheduled goals: goal meaning, selected days, time of day, start date, and either end date, number of weeks/months, or no end date.
- For exam goals like JAMB, WAEC, school tests, or certifications, the exam date/month and weak subjects/topics are high-value details. Ask them before final summary if they are missing and the user has not told you to skip.
- If the user gives daily study hours but not clock time, ask what time of day they want to study before final summary.
- For open-ended routines, use goalEndDate="", estimatedDurationDays=0, estimatedDurationLabel="No end date".
- For selected days less than 7, do not call it every day. Say "every Mon, Wed, and Fri" or similar.
- If the user says "every day except Sunday", selectedDays are Mon to Sat and breakDays is Sun.
- If the user gives a time that has passed today, keep the chosen time and suggest the next valid start day.
- Resolve simple date words yourself. If the user says "next Monday", "Monday next week", "tomorrow", or "today", use the server date to work it out. Do not ask the user for the exact date unless the date is truly unclear.
- Never lock AI-suggested days, time, start date, duration, or plan structure until the user accepts it clearly.
- If you suggest days, time, duration, start date, or plan structure yourself, say "I suggest..." and ask if it works before final summary.
- Any AI-suggested days, time, duration, start date, or plan structure must go into pendingSuggestion first, not locked fields, until the user accepts.
- For early plan-shape suggestions, prefer a safe range before an exact decision. Example: "For staying fit at home, 3 to 5 days usually works well. What days fit you best?" If the user chooses Mon to Fri, accept it.
- Do not present your first suggestion as already chosen. A bad reply says "I suggest a 3-day plan" before knowing the user's aim and schedule. A better reply says "Most home workout routines work well at 3 to 5 days, depending on recovery."
- Do not invent exact study times, workout times, or routine times in the final summary unless the user gave them or accepted your suggestion.
- If a time is already known, never ask for it again. If you need to mention it, say it as memory: "I will keep 5pm."
- Use existing schedule only to avoid conflicts. Do not copy existing shifts into this new goal.
- If you mention a conflict, name the exact goal and time if available. If unsure, ask instead of claiming a clash.
- If you explain advice and offer a next step, end with a clear question like "Do you want me to turn this into a full day guide?". After the user agrees, move to the next useful detail instead of repeating the same advice.

Duration and final-question rules:
- For outcome goals, recommend a realistic duration yourself and briefly say why.
- Do not say "I will recommend". Actually recommend it.
- Do not say "one last thing", "final question", or "one more thing" unless every other important detail is already known.
- Do not apologize for repeating unless the user actually complains that you repeated or says they already answered.
- If you used final/last wording before, your next reply should summarize or get ready, not ask a new normal planning question.
- Final summary must happen once. After the final summary is shown, if the user confirms it, do not ask anything else. Set hasEnoughInfo=true.
- Before the final summary, do not write a summary followed by "Does this look right?". Give a short recommendation, then ask the next missing detail.

Return ONLY valid JSON in this exact shape:
{
  "reply": "short human Goach reply",
  "hasEnoughInfo": false,
  "phase": "understanding | advice | structuring | summary | ready",
  "goalDraft": {
    "goalTitle": "short clear title",
    "goalPlanningType": "outcome | routine | one_time |",
    "userIntent": "complaint | achievement_goal | habit_goal | edit_or_correction | normal_chat | unclear",
    "coreProblem": "plain understanding",
    "suggestedSolution": "plain solution direction",
    "solutionAccepted": false,
    "knownFacts": {
      "direction": "",
      "target": "",
      "successTarget": "",
      "constraints": ""
    },
    "responseMode": "advice_first | goal_planning | quick_build | normal_chat",
    "shouldBuildGoalCard": false,
    "goalParts": {
      "workout": "",
      "food": "",
      "other": ""
    },
    "memorySummary": "",
    "lockedDecisions": [],
    "openQuestions": [],
    "lastQuestionType": "",
    "lastQuestionWasFinal": false,
    "existingBusyTimes": [],
    "finalSummaryOffered": false,
    "finalSummaryConfirmed": false,
    "recommendedStructure": "",
    "structureSuggested": false,
    "structureAccepted": false,
    "levelProgression": "",
    "routineMode": "everyday | custom",
    "selectedDays": [],
    "breakDays": [],
    "breaksNeeded": false,
    "levelNeeded": false,
    "level": "",
    "sessionTimes": [],
    "goalUnderstandingComplete": false,
    "breaksResolved": false,
    "levelResolved": false,
    "goalStartDate": "",
    "goalEndDate": "",
    "estimatedDurationDays": 0,
    "estimatedDurationLabel": "",
    "durationResolved": false
  },
  "fieldUpdates": {
    "selectedDays": false,
    "breakDays": false,
    "sessionTimes": false,
    "goalStartDate": false,
    "goalEndDate": false,
    "estimatedDuration": false
  }
}
`,
        },
        {
          role: "user",
          content: `Current local date: ${currentDateTimeContext.dateISO}
Current local weekday: ${currentDateTimeContext.weekday}
Current local time: ${currentDateTimeContext.time24} (${currentDateTimeContext.timeLabel})

User profile context:
${userCoachContext}

Initial goal text:
${String(goal).trim()}

Conversation so far:
${conversationText}

Current structured draft/memory:
${JSON.stringify(currentDraft, null, 2)}

Existing schedule:
${existingScheduleText}

Existing busy times:
${JSON.stringify(existingBusyTimesMemory, null, 2)}

Start date recommendation if needed:
${JSON.stringify(startDateRecommendationForPrompt, null, 2)}

Controller state from backend:
${JSON.stringify({
  coachMode,
  latestConfirmationIntent,
  userAcceptedGoalCardOffer,
  latestUserWantsNoMoreQuestions,
  previousAssistantNeedsConfirmation,
  shouldLetGoachInterpretReply,
  foodGuideOnlyMode,
  planGuideMode,
  shouldOfferPlanGuide,
}, null, 2)}

Credit/usefulness pressure:
- Assistant replies so far: ${assistantReplyCount}
- If enough is known, summarize instead of asking more.
- If not enough is known, ask only the single most useful missing question.
- If latestUserWantsNoMoreQuestions is true, stop optional discovery and either summarize or ask only the one detail the app truly needs.
- If userAcceptedGoalCardOffer is true, do not ask again whether to make a goal card. Treat that decision as locked.

Generate the next Goach reply now.`,
        },
      ],
      temperature: 0.45,
    });

    const text = response.choices[0].message.content || "";
    const parsed = safeJsonParseFromResponse(text);
    const rawIncomingGoalDraft = parsed?.goalDraft ?? {};
    const rawAcceptedPendingSuggestion =
      userAdjustedPendingSessionDuration
        ? {
            ...(isPlainObject(currentDraft.pendingSuggestion) ? currentDraft.pendingSuggestion : {}),
            sessionTimes: pendingSessionTimes.map((session) => ({
              startTime: session.startTime,
              endTime: addMinutesToTime(session.startTime, pendingSessionDurationMinutes),
            })),
            reason: `${pendingSessionDurationMinutes}-minute session length accepted`,
          }
        : userAcceptedPendingSuggestion && isPlainObject(currentDraft.pendingSuggestion)
          ? currentDraft.pendingSuggestion
        : {};
    const acceptedPendingSuggestion = {};
    const acceptedSelectedDays = normalizeGoalSelectedDays(rawAcceptedPendingSuggestion.selectedDays);
    const acceptedBreakDays = normalizeGoalSelectedDays(rawAcceptedPendingSuggestion.breakDays);
    const acceptedSessionTimes = normalizeGoalSessionTimes(
      rawAcceptedPendingSuggestion.sessionTimes,
      rawAcceptedPendingSuggestion.sessionTime,
    );
    if (acceptedSelectedDays.length > 0) acceptedPendingSuggestion.selectedDays = acceptedSelectedDays;
    if (acceptedBreakDays.length > 0) acceptedPendingSuggestion.breakDays = acceptedBreakDays;
    if (acceptedSessionTimes.length > 0) acceptedPendingSuggestion.sessionTimes = acceptedSessionTimes;
    if (hasMeaningfulTextValue(rawAcceptedPendingSuggestion.routineMode)) {
      acceptedPendingSuggestion.routineMode = rawAcceptedPendingSuggestion.routineMode;
    }
    if (hasMeaningfulTextValue(rawAcceptedPendingSuggestion.goalStartDate)) {
      acceptedPendingSuggestion.goalStartDate = rawAcceptedPendingSuggestion.goalStartDate;
    }
    if (hasMeaningfulTextValue(rawAcceptedPendingSuggestion.goalEndDate)) {
      acceptedPendingSuggestion.goalEndDate = rawAcceptedPendingSuggestion.goalEndDate;
    }
    if (Number(rawAcceptedPendingSuggestion.estimatedDurationDays ?? 0) > 0) {
      acceptedPendingSuggestion.estimatedDurationDays = Number(rawAcceptedPendingSuggestion.estimatedDurationDays);
    }
    if (hasMeaningfulTextValue(rawAcceptedPendingSuggestion.estimatedDurationLabel)) {
      acceptedPendingSuggestion.estimatedDurationLabel = rawAcceptedPendingSuggestion.estimatedDurationLabel;
    }
    if (hasMeaningfulTextValue(rawAcceptedPendingSuggestion.reason)) {
      acceptedPendingSuggestion.reason = rawAcceptedPendingSuggestion.reason;
    }
    const incomingGoalDraft = Object.keys(acceptedPendingSuggestion).length > 0
      ? mergeStructuredObjects(rawIncomingGoalDraft, acceptedPendingSuggestion)
      : rawIncomingGoalDraft;
    const fieldUpdates = {
      ...(parsed?.fieldUpdates ?? {}),
      selectedDays: Boolean(parsed?.fieldUpdates?.selectedDays || acceptedPendingSuggestion.selectedDays),
      breakDays: Boolean(parsed?.fieldUpdates?.breakDays || acceptedPendingSuggestion.breakDays),
      sessionTimes: Boolean(parsed?.fieldUpdates?.sessionTimes || acceptedPendingSuggestion.sessionTimes),
      goalStartDate: Boolean(parsed?.fieldUpdates?.goalStartDate || hasMeaningfulTextValue(acceptedPendingSuggestion.goalStartDate)),
      goalEndDate: Boolean(parsed?.fieldUpdates?.goalEndDate || hasMeaningfulTextValue(acceptedPendingSuggestion.goalEndDate)),
      estimatedDuration: Boolean(
        parsed?.fieldUpdates?.estimatedDuration ||
          acceptedPendingSuggestion.estimatedDurationDays ||
          acceptedPendingSuggestion.estimatedDurationLabel
      ),
    };

    const currentSelectedDays = normalizeGoalSelectedDays(currentDraft.selectedDays);
    const incomingSelectedDays = normalizeGoalSelectedDays(incomingGoalDraft.selectedDays);
    const inferredSelectedDaysFromRaw = inferSelectedDaysFromText(String(latestUserMessage ?? "").toLowerCase());
    const inferredSelectedDays = inferredSelectedDaysFromRaw.length > 0
      ? inferredSelectedDaysFromRaw
      : inferSelectedDaysFromText(latestUserMessage);
    const previousAskedForDays = /\b(which days|what days|days should this happen|every day|mon to fri|specific days)\b/i.test(previousAssistantReply);
    const canUseInferredSelectedDays =
      currentSelectedDays.length === 0 &&
      incomingSelectedDays.length === 0 &&
      inferredSelectedDays.length > 0 &&
      (previousAskedForDays || /\b(only on|every|weekdays|weekends|days?)\b/i.test(latestUserMessage));
    const inferredDaysLookMoreComplete =
      inferredSelectedDays.length > incomingSelectedDays.length &&
      /\b(mon|monday)\b[\s\S]{0,16}\b(fri|friday)\b/i.test(latestUserMessage);
    const selectedDays = canUseInferredSelectedDays && inferredDaysLookMoreComplete
      ? inferredSelectedDays
      : incomingSelectedDays.length > 0 &&
        (fieldUpdates.selectedDays || currentSelectedDays.length === 0)
          ? incomingSelectedDays
          : canUseInferredSelectedDays
            ? inferredSelectedDays
            : currentSelectedDays;
    if (canUseInferredSelectedDays || inferredDaysLookMoreComplete) {
      fieldUpdates.selectedDays = true;
    }

    const currentSessionTimes = normalizeGoalSessionTimes(
      currentDraft.sessionTimes,
      currentDraft.sessionTime,
    );
    const incomingSessionTimes = normalizeGoalSessionTimes(
      incomingGoalDraft.sessionTimes,
      incomingGoalDraft.sessionTime,
    );
    const inferredSleepSessionTimes = inferSleepSessionTimesFromText(latestUserMessage);
    const inferredSessionTimes = inferredSleepSessionTimes.length > 0
      ? inferredSleepSessionTimes
      : inferSingleSessionTimeFromText(latestUserMessage);
    const previousAskedForTime = /\b(time|what time|when should|when do you want|time of day)\b/i.test(previousAssistantReply);
    const inferredSessionNeedsConfirmation = inferredSessionTimes.some((session) => session.inferredEndTime);
    const inferredSessionsLookMoreComplete =
      inferredSessionTimes.length > incomingSessionTimes.length &&
      inferredSessionTimes.length > currentSessionTimes.length &&
      !inferredSessionNeedsConfirmation;
    const canUseInferredSessionTime =
      currentSessionTimes.length === 0 &&
      incomingSessionTimes.length === 0 &&
      inferredSessionTimes.length > 0 &&
      (previousAskedForTime || inferredSleepSessionTimes.length > 0) &&
      !inferredSessionNeedsConfirmation;
    const sessionTimes = inferredSessionsLookMoreComplete
      ? inferredSessionTimes
      : incomingSessionTimes.length > 0 &&
      (fieldUpdates.sessionTimes || currentSessionTimes.length === 0)
        ? incomingSessionTimes
        : canUseInferredSessionTime
          ? inferredSessionTimes
          : currentSessionTimes;
    if (canUseInferredSessionTime || inferredSessionsLookMoreComplete) {
      fieldUpdates.sessionTimes = true;
    }

    const currentBreakDays = normalizeGoalSelectedDays(currentDraft.breakDays);
    const incomingBreakDays = normalizeGoalSelectedDays(incomingGoalDraft.breakDays);
    const inferredBreakDays =
      canUseInferredSelectedDays && selectedDays.length > 0 && selectedDays.length < 7
        ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].filter((day) => !selectedDays.includes(day))
        : [];
    const breakDays = fieldUpdates.breakDays
      ? incomingBreakDays
      : currentBreakDays.length
        ? currentBreakDays
        : incomingBreakDays.length
          ? incomingBreakDays
          : inferredBreakDays;
    if (inferredBreakDays.length > 0) {
      fieldUpdates.breakDays = true;
    }

    const inferredStartDate = inferStartDateFromText(
      /\b(date|start|when|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i.test(previousAssistantReply)
        ? `${previousAssistantReply} ${latestUserMessage}`
        : latestUserMessage,
      now,
    );
    const latestUserChangedStartDate =
      Boolean(inferredStartDate) &&
      /\b(start|begin|from|use|make it|move it|tomorrow|today|tonight|next\s+week|next\s+month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i.test(latestUserMessage);
    const goalStartDate = String(
      fieldUpdates.goalStartDate && incomingGoalDraft.goalStartDate
        ? incomingGoalDraft.goalStartDate
        : latestUserChangedStartDate
          ? inferredStartDate
          : currentDraft.goalStartDate || incomingGoalDraft.goalStartDate || inferredStartDate || "",
    ).trim();
    if ((!currentDraft.goalStartDate && !incomingGoalDraft.goalStartDate && inferredStartDate) || latestUserChangedStartDate) {
      fieldUpdates.goalStartDate = true;
    }

    const goalEndDate = String(
      fieldUpdates.goalEndDate
        ? incomingGoalDraft.goalEndDate ?? ""
        : currentDraft.goalEndDate || incomingGoalDraft.goalEndDate || "",
    ).trim();

    const estimatedDurationDays = Number(
      fieldUpdates.estimatedDuration && Number(incomingGoalDraft.estimatedDurationDays ?? 0) > 0
        ? incomingGoalDraft.estimatedDurationDays
        : currentDraft.estimatedDurationDays || incomingGoalDraft.estimatedDurationDays || 0,
    );
    const estimatedDurationLabel = String(
      fieldUpdates.estimatedDuration && incomingGoalDraft.estimatedDurationLabel
        ? incomingGoalDraft.estimatedDurationLabel
        : currentDraft.estimatedDurationLabel || incomingGoalDraft.estimatedDurationLabel || "",
    ).trim();

    const goalDraft = normalizeGoalForm({
      goalMeta: {
        ...currentDraft,
        ...incomingGoalDraft,
        selectedDays,
        breakDays,
        sessionTimes,
        goalStartDate,
        goalEndDate,
        estimatedDurationDays,
        estimatedDurationLabel,
        knownFacts: mergeKnownFacts(currentDraft.knownFacts, incomingGoalDraft.knownFacts),
        goalParts: mergeStructuredObjects(currentDraft.goalParts, incomingGoalDraft.goalParts),
        pendingSuggestion: userAcceptedPendingSuggestion || userAdjustedPendingSessionDuration
          ? {}
          : inferredSessionNeedsConfirmation && inferredSessionTimes.length > 0
            ? {
                ...(isPlainObject(incomingGoalDraft.pendingSuggestion)
                  ? incomingGoalDraft.pendingSuggestion
                  : currentDraft.pendingSuggestion),
                sessionTimes: inferredSessionTimes.map(({ startTime, endTime }) => ({ startTime, endTime })),
                reason: "suggested session end time",
              }
            : isPlainObject(incomingGoalDraft.pendingSuggestion)
              ? incomingGoalDraft.pendingSuggestion
              : currentDraft.pendingSuggestion,
        responseMode:
          planGuideMode
            ? "plan_guide"
            : userExplicitlyRequestedScheduledGoal || actionPlanShouldBecomeGoalCard
              ? "quick_build"
              : latestUserRequestedAdviceOnly
                ? "advice_first"
                : (() => {
                    const incomingMode = normalizeResponseMode(incomingGoalDraft.responseMode);
                    if (incomingMode === "plan_guide") return "quick_build";
                    return incomingMode ||
                      normalizeResponseMode(currentDraft.responseMode) ||
                      (coachMode === "quick_build" ? "quick_build" : "");
                  })(),
        shouldBuildGoalCard: foodGuideOnlyMode || planGuideMode
          ? false
          : Boolean(
              incomingGoalDraft.shouldBuildGoalCard ||
                currentDraft.shouldBuildGoalCard ||
                isExplicitGoalBuildRequest(latestUserMessage) ||
                userExplicitlyRequestedScheduledGoal ||
                actionPlanShouldBecomeGoalCard ||
                userAcceptedGoalCardOffer,
            ),
        memorySummary:
          normalizeMemoryText(incomingGoalDraft.memorySummary) ||
          normalizeMemoryText(currentDraft.memorySummary),
        lockedDecisions: normalizeMemoryList(
          [
            ...normalizeMemoryList(currentDraft.lockedDecisions, 8),
            ...normalizeMemoryList(incomingGoalDraft.lockedDecisions, 8),
            ...(userAcceptedPendingSuggestion || userAdjustedPendingSessionDuration
              ? normalizeMemoryList([acceptedPendingSuggestion.reason || "accepted Goach suggestion"], 2)
              : []),
            ...(userAcceptedGoalCardOffer
              ? normalizeMemoryList(["goal card accepted"], 1)
              : []),
            ...(latestUserWantsNoMoreQuestions
              ? normalizeMemoryList(["user wants no extra questions"], 1)
              : []),
          ],
          8,
        ),
        openQuestions: normalizeMemoryList(incomingGoalDraft.openQuestions, 3),
        existingBusyTimes: existingBusyTimesMemory,
      },
      fallbackGoal: goal,
    });

    const userCorrectedFinalSummary =
      previousAssistantWasSummary &&
      !userAcceptedSummary &&
      Boolean(
        fieldUpdates.selectedDays ||
          fieldUpdates.breakDays ||
          fieldUpdates.sessionTimes ||
          fieldUpdates.goalStartDate ||
          fieldUpdates.goalEndDate ||
          fieldUpdates.estimatedDuration ||
          latestUserAskedDirectQuestion,
      );

    if (!userAcceptedSummary) {
      goalDraft.finalSummaryConfirmed = false;
    }
    if (userCorrectedFinalSummary) {
      goalDraft.finalSummaryOffered = false;
      goalDraft.finalSummaryConfirmed = false;
    }
    if (latestUserRequestedAdviceOnly) {
      goalDraft.shouldBuildGoalCard = false;
      goalDraft.responseMode = "advice_first";
      goalDraft.goalPlanningType = goalDraft.goalPlanningType || "one_time";
    } else if (foodGuideOnlyMode) {
      goalDraft.shouldBuildGoalCard = false;
      goalDraft.responseMode = "advice_first";
      goalDraft.goalPlanningType = goalDraft.goalPlanningType || "one_time";
    } else if (planGuideMode) {
      goalDraft.shouldBuildGoalCard = false;
      goalDraft.responseMode = "plan_guide";
      goalDraft.goalPlanningType = goalDraft.goalPlanningType || "one_time";
    } else if (userAcceptedGoalCardOffer || userExplicitlyRequestedScheduledGoal || actionPlanShouldBecomeGoalCard) {
      goalDraft.shouldBuildGoalCard = true;
      goalDraft.responseMode = "quick_build";
    }

    if (
      actionPlanShouldBecomeGoalCard &&
      goalDraft.shouldBuildGoalCard &&
      (!goalDraft.goalPlanningType || goalDraft.goalPlanningType === "one_time")
    ) {
      goalDraft.goalPlanningType = "routine";
    }

    const isOneTimeGoal = goalDraft.goalPlanningType === "one_time";
    const needsScheduledShift = !isOneTimeGoal && goalDraft.shouldBuildGoalCard !== false;
    const hasDays = isOneTimeGoal || goalDraft.selectedDays.length > 0;
    const hasRoutineMode = isOneTimeGoal || Boolean(goalDraft.routineMode);
    const hasSessionTime = isOneTimeGoal || !needsScheduledShift || goalDraft.sessionTimes.length > 0;
    const hasStartDate = isOneTimeGoal || !needsScheduledShift || Boolean(goalDraft.goalStartDate);
    const isOutcomeGoal = goalDraft.goalPlanningType === "outcome";
    const hasResolvedDurationValue = Boolean(
      goalDraft.goalEndDate ||
        goalDraft.estimatedDurationDays > 0 ||
        (goalDraft.estimatedDurationLabel && goalDraft.estimatedDurationLabel.toLowerCase() !== "no end date") ||
        goalDraft.durationResolved,
    );
    const durationResolved = Boolean(
      isOneTimeGoal ||
        (isOutcomeGoal
          ? hasResolvedDurationValue
          : goalDraft.durationResolved ||
            goalDraft.goalPlanningType === "routine" ||
            goalDraft.goalEndDate ||
            goalDraft.estimatedDurationLabel ||
            goalDraft.estimatedDurationDays > 0),
    );
    const checklist = {
      goalUnderstandingComplete: Boolean(goalDraft.goalUnderstandingComplete || goalDraft.coreProblem || goalDraft.suggestedSolution),
      goalPlanningTypeComplete: Boolean(goalDraft.goalPlanningType),
      durationResolved,
      selectedDaysComplete: hasDays,
      routineModeComplete: hasRoutineMode,
      sessionTimesComplete: hasSessionTime,
      goalStartDateComplete: hasStartDate,
      breaksResolved: Boolean(isOneTimeGoal || goalDraft.breaksResolved || goalDraft.breakDays.length > 0 || goalDraft.selectedDays.length > 0),
      levelResolved: Boolean(isOneTimeGoal || goalDraft.levelResolved || goalDraft.level || !goalDraft.levelNeeded),
    };
    const checklistComplete = Object.values(checklist).every(Boolean);
    const pickCoachQuestion = (type) => {
      const seedText = `${type}|${latestUserMessage}|${conversationText.length}|${goalDraft.goalTitle || goalDraft.title || goal}`;
      const seed = Array.from(seedText).reduce((sum, char) => sum + char.charCodeAt(0), 0);
      const variants = {
        result: [
          "I understand the goal. What result should this plan help you reach?",
          "I get the direction. What should this plan help you achieve?",
          "That makes sense. What outcome are we aiming for here?",
          "I am with you. What result would make this plan feel successful?",
        ],
        planningType: [
          "Should this be something you repeat, a goal with an end date, or one thing you only need to do once?",
          "How should I treat this: a repeated routine, a goal with a finish point, or a one-time task?",
          "Is this a routine you keep doing, something with an end date, or just one action?",
          "Should this keep repeating, stop after a set time, or happen just once?",
        ],
        days: [
          "What days should I place this on?",
          "Should this run every day, weekdays, or only certain days?",
          "For the schedule, which days fit you best?",
          "Which days should Goach use for this routine?",
          "Do you want this daily, Mon to Fri, or on selected days?",
        ],
        routineMode: [
          "Should this repeat every day, or only on the days you picked?",
          "Do you want it to repeat daily, or just follow the selected days?",
          "Should Goach treat this as daily, or only on those chosen days?",
          "Should this happen every day, or only when those days come around?",
        ],
        time: [
          "What time should we use for it?",
          "What time of day should I place this?",
          "When should this happen during the day?",
          "What time works best for this routine?",
          "What start time should Goach use?",
        ],
        breaks: [
          "Do you want any rest days, or should I use the days you picked?",
          "Should I add any break days, or keep it on the selected days?",
          "Do you want rest days built in, or should the chosen days stay as they are?",
          "Should Goach leave any days free, or use the schedule you picked?",
        ],
        level: [
          "What level should I plan for: beginner, intermediate, or advanced?",
          "What level fits you best right now: beginner, intermediate, or advanced?",
          "Should I make this beginner, intermediate, or advanced?",
          "How hard should I make it: beginner, intermediate, or advanced?",
        ],
      };
      const options = variants[type] || variants.result;
      return options[seed % options.length];
    };
    const buildMissingReadyDetailReply = () => {
      if (!checklist.goalUnderstandingComplete) {
        return pickCoachQuestion("result");
      }

      if (!checklist.goalPlanningTypeComplete) {
        return pickCoachQuestion("planningType");
      }
      if (!checklist.durationResolved) {
        return buildDurationRecommendationReply(goalDraft);
      }
      if (!checklist.selectedDaysComplete) {
        return pickCoachQuestion("days");
      }
      if (!checklist.routineModeComplete) {
        return pickCoachQuestion("routineMode");
      }
      if (!checklist.sessionTimesComplete) {
        return pickCoachQuestion("time");
      }
      if (!checklist.goalStartDateComplete) {
        return buildGoalStartDateReply(goalDraft, now);
      }
      if (!checklist.breaksResolved) {
        return pickCoachQuestion("breaks");
      }
      if (!checklist.levelResolved) {
        return pickCoachQuestion("level");
      }
      return buildGoalFinalSummaryReply(goalDraft);
    };

    let reply = String(parsed?.reply ?? "").trim() ||
      "I am with you. Tell me the main thing you want this goal to help you achieve.";

    reply = reply
      .replace(/time window/gi, "time of day")
      .replace(new RegExp(`I${String.fromCharCode(0xfffd)}ll`, "g"), "I will")
      .replace(new RegExp(`You${String.fromCharCode(0xfffd)}re`, "g"), "You are")
      .replace(new RegExp(String.fromCharCode(0xe2, 0x80, 0x99), "g"), "'")
      .replace(new RegExp(`${String.fromCharCode(0xe2, 0x80, 0x9c)}|${String.fromCharCode(0xe2, 0x80, 0x9d)}`, "g"), '"');

    if (shouldOfferPlanGuide && !reply.includes("?")) {
      reply = buildMissingReadyDetailReply();
    }

    if (shouldOfferPlanGuide && reply.includes("?") && !/\b(advice|plan guide|simple advice|actions you can follow)\b/i.test(reply)) {
      reply = buildMissingReadyDetailReply();
    }

    if (userAdjustedPendingSessionDuration && /\b(do you mean yes or no|does that work|is that okay|should i|what time)\b/i.test(reply)) {
      reply = buildMissingReadyDetailReply();
    }

    if (planGuideMode && /\b(which days should this happen|what time should we use|should this start|goal card|shift|reminder|here is the plan i am about to build|does this look right|for this, i recommend|is that okay)\b/i.test(reply)) {
      reply = buildMissingReadyDetailReply();
    }

    if (
      previousAssistantNeedsConfirmation &&
      latestConfirmationIntent === "accept" &&
      replyLooksLikeRepeatedOffer(reply, previousAssistantReply)
    ) {
      reply = buildAcceptedOfferNextStepReply({
        previousReply: previousAssistantReply,
        goalDraft,
        goal,
        checklist,
      });
    }

    if (inferredSessionNeedsConfirmation && inferredSessionTimes.length > 0 && !userAcceptedPendingSuggestion) {
      reply = buildSessionTimeConfirmationReply(inferredSessionTimes);
    }

    if (foodGuideOnlyMode) {
      const asksScheduleForGuide = /\b(which days should this happen|what time should we use|should this start|goal card|shift|reminder)\b/i.test(reply);
      const repeatsFoodOffer = replyLooksLikeRepeatedOffer(reply, previousAssistantReply);
      if (asksScheduleForGuide || repeatsFoodOffer || latestConfirmationIntent === "accept" || latestUserWantsNoMoreQuestions) {
        reply = buildFoodGuideProgressReply({ conversationText, latestUserMessage, previousAssistantReply });
      }
    }

    if (latestUserWantsNoMoreQuestions) {
      if (planGuideMode) {
        reply = buildMissingReadyDetailReply();
      } else if (foodGuideOnlyMode) {
        reply = buildFoodGuideProgressReply({ conversationText, latestUserMessage, previousAssistantReply });
      } else if (checklistComplete && goalDraft.shouldBuildGoalCard) {
        reply = buildGoalFinalSummaryReply({ ...goalDraft, finalSummaryOffered: true });
        goalDraft.finalSummaryOffered = true;
        goalDraft.finalSummaryConfirmed = false;
      } else if (/\b(do you want|want me to|should i|can i|if you want|what detail should we settle)\b/i.test(reply)) {
        reply = buildMissingReadyDetailReply();
      }
    }

    if (replyAsksForResolvedDetail(reply, checklist)) {
      reply = buildMissingReadyDetailReply();
    }

    if (/\bdo you mean yes or no\b/i.test(reply)) {
      reply = shouldLetGoachInterpretReply
        ? buildMissingReadyDetailReply()
        : buildUnclearConfirmationReply(previousAssistantReply);
    }

    const replyContainsQuestion = reply.includes("?");
    const canShowFinalSummary =
      checklistComplete &&
      goalDraft.shouldBuildGoalCard &&
      !goalDraft.finalSummaryConfirmed &&
      !latestUserAskedDirectQuestion;

    if (
      !goalDraft.shouldBuildGoalCard &&
      /here is the plan i am about to build/i.test(reply)
    ) {
      reply = "I can help you shape this first, then turn it into a goal card when you are ready. What part should we make clearer?";
    }

    if (isPrematureFinalSummaryReply(reply) && !checklistComplete) {
      reply = buildMissingReadyDetailReply();
      goalDraft.finalSummaryOffered = false;
      goalDraft.finalSummaryConfirmed = false;
    }

    if (/\b(here is|here s|heres)\b[\s\S]{0,120}\b(does this look right|does that look right)\b/i.test(reply) && !checklist.sessionTimesComplete && goalDraft.shouldBuildGoalCard) {
      reply = pickCoachQuestion("time");
      goalDraft.finalSummaryOffered = false;
      goalDraft.finalSummaryConfirmed = false;
    }

    if (isPrematureFinalSummaryReply(reply) && goalDraft.finalSummaryOffered && !userAcceptedSummary) {
      reply = buildMissingReadyDetailReply();
    }

    if (canShowFinalSummary && !isPrematureFinalSummaryReply(reply)) {
      reply = buildGoalFinalSummaryReply({
        ...goalDraft,
        finalSummaryOffered: true,
      });
      goalDraft.finalSummaryOffered = true;
    }

    if (isRepeatedCoachReply(reply, previousAssistantReply) || replyAsksForResolvedDetail(reply, checklist)) {
      reply = userComplainedAboutRepeat
        ? buildMissingReadyDetailReply()
        : buildMissingReadyDetailReply();
    }

    if (usesFinalQuestionWording(reply) && !checklistComplete) {
      reply = softenPrematureFinalQuestionWording(reply);
    }

    if (reply.includes("?") && usesFinalQuestionWording(previousAssistantReply)) {
      reply = checklistComplete
        ? buildGoalFinalSummaryReply({ ...goalDraft, finalSummaryOffered: true })
        : "Good. I will use what you gave me and shape the plan from here.";
    }

    if (canShowFinalSummary) {
      goalDraft.finalSummaryOffered = true;
      goalDraft.finalSummaryConfirmed = false;
    }
    if (!reply.includes("?")) {
      goalDraft.lastQuestionType = "";
      goalDraft.lastQuestionWasFinal = false;
    }

    if ((Boolean(parsed?.hasEnoughInfo) || /your plan is ready to build now/i.test(reply)) && !checklistComplete) {
      reply = buildMissingReadyDetailReply();
      goalDraft.finalSummaryConfirmed = false;
      goalDraft.finalSummaryOffered = false;
    }

    if (userAcceptedSummary && checklistComplete) {
      goalDraft.finalSummaryConfirmed = true;
      goalDraft.finalSummaryOffered = true;
    }

    const durationSuggestionFromReply = inferDurationSuggestionFromReply(reply);
    if (
      durationSuggestionFromReply &&
      goalDraft.shouldBuildGoalCard &&
      !goalDraft.durationResolved &&
      !goalDraft.goalEndDate &&
      !goalDraft.estimatedDurationLabel
    ) {
      goalDraft.pendingSuggestion = {
        ...(isPlainObject(goalDraft.pendingSuggestion) ? goalDraft.pendingSuggestion : {}),
        ...durationSuggestionFromReply,
      };
    }

    const readyNow = checklistComplete && goalDraft.finalSummaryConfirmed;
    const remainingCredits = await deductCreditsAfterSuccess(req);

    res.json({
      reply: readyNow ? "Your plan is ready to build now." : reply,
      hasEnoughInfo: readyNow,
      phase: readyNow ? "ready" : String(parsed?.phase ?? "contextual"),
      goalDraft,
      checklist,
      lockedFields: getLockedGoalDraftFields(goalDraft),
      startDateRecommendation: !hasStartDate
        ? resolveGoalStartDateRecommendation(goalDraft, now)
        : null,
      remainingCredits,
    });
  } catch (err) {
    console.log("NEXT QUESTION AI ERROR:", err);
    res.status(500).json({
      error: "Failed to generate next question",
      details: err?.message || "Unknown error",
    });
  }
});
app.post("/generate-summary", checkCredits, async (req, res) => {
  try {
    const { goal, messages = [] } = req.body;
    const userCoachContext = await getUserCoachContext(req.userId);


    if (!goal || !String(goal).trim()) {
      return res.status(400).json({ error: "Goal is required" });
    }

    const conversationText = Array.isArray(messages)
      ? messages
        .map((item, index) => {
          const role = String(item?.role ?? "user");
          const content = String(item?.content ?? "").trim();
          return `${index + 1}. ${role.toUpperCase()}: ${content}`;
        })
        .join("\n")
      : "";

    const response = await client.chat.completions.create({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "system",
         content: `
You are an expert AI goal coach.

You will receive:
- the user's goal
- the coaching conversation so far

Your job:
Create a short, exciting outcome preview before the plan is generated.

Rules:
${buildSimpleCoachVoiceRules()}
- Keep it brief.
- Do NOT write a long paragraph.
- Speak directly to the user in a warm coach tone.
- If the user's preferred name is available, use it naturally.
- Focus on the end result the user is working toward.
- Mention the user's specific target if they gave one.
- Never guarantee results absolutely.
- Use phrases like "if you stay consistent", "if you follow the plan", or "with solid consistency".
- Do NOT create the final schedule yet.
- Do NOT list daily shifts.
- Do NOT use boring section names like "Shift Preview".
- Create 3 to 5 milestone previews.
- Milestones should show progress across the full goal timeline.
- For weight, fitness, study, business, or money goals, make milestones specific and realistic.
- If exact numbers are not known, use realistic progress language instead of fake certainty.

Good summary example:
"Henry, you said you want to lean bulk from 77kg to 85kg. Real nice. If you stay consistent with the workouts, food, sleep, and recovery, this plan should guide you toward that 85kg target in a realistic way."

Good milestone examples:
- Week 1: Settle into the routine and learn the workout rhythm.
- Week 14: You should be noticeably stronger and moving toward about 80kg if nutrition is consistent.
- Week 32: You should be close to the 85kg target if training, food, and recovery stay steady.

Return ONLY valid JSON in this exact format:
{
  "summaryTitle": "Your End Goal",
  "summaryText": "One short outcome-focused paragraph, max 2 sentences.",
  "shiftPreview": [
    {
      "title": "Week 1",
      "description": "Short milestone result."
    },
    {
      "title": "Week 14",
      "description": "Short milestone result."
    },
    {
      "title": "Week 32",
      "description": "Short milestone result."
    }
  ]
}
`,
        },
        {
          role: "user",
          
          content: `User profile context:
${userCoachContext}

Goal:
${String(goal).trim()}

Conversation:
${conversationText || "No conversation provided."}

Create the summary now.`,
        },
      ],
      temperature: 0.6,
    });

        const text = response.choices[0].message.content || "";
    const parsed = safeJsonParseFromResponse(text);
    const remainingCredits = await deductCreditsAfterSuccess(req);

    res.json({
      summaryTitle: String(parsed?.summaryTitle ?? "Your End Goal").trim(),
      summaryText: String(parsed?.summaryText ?? "Your plan is ready to build.").trim(),
      shiftPreview: Array.isArray(parsed?.shiftPreview)
        ? parsed.shiftPreview
        : [],
      remainingCredits,
    });
  } catch (err) {
    console.log("SUMMARY AI ERROR:", err);
    res.status(500).json({
      error: "Failed to generate summary",
      details: err?.message || "Unknown error",
    });
  }
});

app.post("/generate-plan", checkCredits, async (req, res) => {
  try {
    const {
  goal,
  messages = [],
  includeImages = true,
  existingSchedule = [],
  currentGoalMeta = null,
} = req.body;

    const existingScheduleText = formatExistingScheduleForAI(existingSchedule);
    const existingBusyTimesMemory = buildExistingBusyTimesMemory(existingSchedule);
    const userCoachContext = await getUserCoachContext(req.userId);

    const freeTimeSuggestionsText =
      buildFreeTimeSuggestionsForAI(existingSchedule);

    if (!goal || !String(goal).trim()) {
      return res.status(400).json({ error: "Goal is required" });
    }

    const now = new Date();
    const currentWeekday = getCurrentWeekdayLabel(now);
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(
      now.getMinutes(),
    ).padStart(2, "0")}`;

    const conversationText = Array.isArray(messages)
      ? messages
        .map((item, index) => {
          const role = String(item?.role ?? "user");
          const content = String(item?.content ?? "").trim();
          return `${index + 1}. ${role.toUpperCase()}: ${content}`;
        })
        .join("\n")
      : "";

    const response = await client.chat.completions.create({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "system",
          content: `
You are an expert AI goal coach.

You will receive:
- the user's goal
- the full chat conversation used to understand the user
- the current day and time

Your job:
Create a realistic long-horizon roadmap for the user, but only schedule the next 7 to 14 days as actual app-ready shifts.

Rules:
- Return ONLY a valid JSON object with two keys: "goalMeta" and "plan"
- Respect the user's answers deeply
- Use the answers as the main planning hints
- Think long-term and realistically about the goal
- Start from basic and progress gradually toward advanced
- Do not shock the user with advanced difficulty immediately
- Only schedule the next 7 to 14 days as actual app-ready shifts
- The shifts should represent the current action window, not the user's entire journey
- Some goals realistically take multiple weeks or months; do not pretend they can be completed in one week
- If the goal is large or long-term, the first 7 to 14 days should focus on foundation, consistency, and setup rather than pretending the final result is close
- Prefer a mix of realistic schedule structures when helpful:
  - recurring weekday patterns
  - week-based blocks
  - month-based focus blocks
  - exact date tasks for milestones or special events
- Use richer planning fields when useful instead of flattening everything into weekday-only shifts
- No overlapping shifts on the same day or within the same target bucket
- Do not create duplicate shifts for the same weekday and session window.
- If the user requested exactly one session window, create only one recurring shift per selected weekday.
- Do not invent an additional session unless the user explicitly requested multiple sessions.
- Recurring weekday shifts are schedule templates and must preserve the user's confirmed session time.
- If today's confirmed session time has already passed, keep the time unchanged and let the first occurrence happen on the next matching day.
- Never move a confirmed morning session into the evening or night just to make it later than the current time.
- Exact-date shifts for today must not be created in the past.
- Keep the plan achievable and realistic
- Only adapt to injuries, pain, physical limitations, deformities, or mobility issues if the user actually mentioned them or the goal makes it relevant
- For health, illness, cancer, treatment, surgery, medication, or recovery-related goals, create only a safe support routine
- Do NOT create a treatment plan
- Do NOT recommend medication, supplements, diets, cures, or medical procedures
- Include gentle support shifts only, such as rest, hydration reminders, symptom journaling, medication reminder structure, appointment preparation, light doctor-approved activity, and emotional support
- Every health-related explanation must remind the user to follow their doctor/oncologist/medical team's advice
- If the plan includes movement, clearly say "only if your doctor allows it"
- If the user insisted on a suboptimal preference, respect it, but still keep the plan coherent
- Each shift should support the user's success in the real world
- Session lengths must be realistic for the goal type and stage; do not default to 30 minutes unless it truly makes sense
- For large goals like building muscle, JAMB preparation, or starting a real business, focus on the foundation phase first
- Each shift should also show progression: start simple first, then build difficulty gradually in later phases
- Do not give advanced tasks too early unless the user already said they are advanced
- For beginner users, make the first action window easy enough to start but strong enough to create momentum
- If the user has a long-term goal, explain how this shift supports the current phase, not the entire goal at once
Return this exact JSON shape:
{
"goalMeta": {
  "goalTitle": "short clear goal title",
  "routineMode": "everyday | custom",
  "selectedDays": ["Mon", "Tue"],
  "goalStartDate": "YYYY-MM-DD",
  "goalEndDate": "YYYY-MM-DD",
  "estimatedDurationDays": 0,
  "estimatedDurationLabel": "string",
  "currentPhaseLabel": "string"
},
  "plan": [
    {
      "title": "short clear action title, max 4 words",
      "startTime": "18:00",
      "endTime": "19:00",
      "explanation": "string",
      "category": "workout | cooking | study | sleep | meditation | money",
      "imageSearchQuery": "string",
      "timeframeType": "day | week | month | year",
      "timeframeValue": 1,
      "targetType": "weekday | date | week | month | year",
      "difficultyLevel": "basic | intermediate | advanced",
      "weekdayLabel": "Mon",
      "plannedDate": "YYYY-MM-DD",
      "targetKey": "string",
      "targetLabel": "string",
      "phaseLabel": "string",
"resourceLinks": [
  {
    "title": "What is diamond push-up?",
    "query": "what is diamond push-up exercise",
    "type": "search"
  },
  {
    "title": "Watch diamond push-up form",
    "query": "diamond push-up proper form beginner",
    "type": "video"
  }
]


    }
  ]
}

Rules for goalMeta:
- goalTitle must be generated from the user's actual goal and conversation
- goalTitle must be short, clear, and specific
- goalTitle must NOT be generic
- Do NOT use generic titles like "Performance Upgrade", "Wealth Building System", "AI Success Blueprint", "Success Plan", or "Routine Plan"
- Good goalTitle examples:
  - "Car Business"
  - "Fever Support"
  - "JAMB Preparation"
  - "Muscle Growth"
  - "Real Estate Foundation"
- goalStartDate should usually be today or the next realistic start date
- goalEndDate should reflect the realistic horizon of the full goal, not just the next 7 to 14 days
- For routines the user wants every day/daily/forever/till infinite/no end date, set goalEndDate="", estimatedDurationDays=0, and estimatedDurationLabel="No end date".
- For open-ended routines, do NOT invent a 365-day, 366-day, 12-month, or 1-year end date.
- estimatedDurationDays must match the realistic goal horizon
- estimatedDurationLabel should be human-friendly, like "5 months" or "12 weeks"
- currentPhaseLabel should describe the present phase, like "Foundation", "Build-Up", "Practice", "Launch", or "Revision"
- goalMeta is the app form source of truth.
- routineMode must be "everyday" only when the user wants all 7 days.
- routineMode must be "custom" when the user wants selected days only.
- selectedDays must always be an array using only: "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun".
- Understand natural day language like "mon to fri", "weekdays", "every day", "weekends", and misspellings like "Monbday" or "Frday".
- If user says "Mon to Fri", selectedDays must be ["Mon","Tue","Wed","Thu","Fri"].
- If user says "weekends", selectedDays must be ["Sat","Sun"].
- If user says "every day" or "daily", selectedDays must include all 7 days and routineMode must be "everyday".
- The plan weekday shifts must match goalMeta.selectedDays unless using exact date/week/month/year scheduling.

Rules for plan:
- plan must contain only the next 7 to 14 days of app-ready shifts
- Every shift title must be short, clear, and action-based
- A user should understand the shift from the title alone
- Do NOT use vague titles like "Session", "Routine", "Task", "Focus Time", "Foundation", or "Action Step"
- Good shift title examples:
  - "Research Car Market"
  - "List Car Suppliers"
  - "Check Body Temperature"
  - "Drink Water Slowly"
  - "Solve Math Questions"
  - "Practice Push-ups"
- each item must support the current action window, not the entire goal
- use richer planning structure when useful

Rules for explanations and resourceLinks:
- explanation must be specific, practical, and easy to follow
- NEVER use vague words like "work on", "focus on", "improve", "build", or "practice" without saying exactly what the user should do
- Every explanation must feel like a mini-coach instruction the user can follow immediately

Every explanation must include:
1. Exact action
2. Exact number or duration where possible
3. Step-by-step method
4. Form/quality/checkpoint cue
5. Why this shift matters
6. What the user should finish with

For workout shifts:
- Name exact exercises
- Include sets and reps
- Include body position
- Include form cues
- Include rest time
- Keep it safe and beginner-friendly
For illness/recovery support shifts:
- Do not use intense workout language
- Keep actions gentle and supportive
- Example:
Hydration check: drink water slowly
Write down your energy level from 1 to 10
Note any pain, nausea, fever, or unusual symptoms
Rest for 10 minutes after
Share serious symptoms with your doctor
This helps you track your body without guessing

Example workout explanation:
Pike push-up: 3 sets ÃƒÆ’Ã¢â‚¬â€ 8 reps
Put your feet and hands on the floor
Raise your hips high so your body forms a V shape
Tuck your head between your shoulders
Lower your head close to the ground slowly
Push back up with control
Rest 45 seconds between sets
This helps build shoulder strength for upper-body growth

For study shifts:
- Name the exact topic
- Tell the user what to read/watch
- Tell the user how many questions to solve
- Tell the user how to mark weak areas
- Tell the user what result they should finish with

Example study explanation:
Study Algebra: linear equations
Read your note for 10 minutes
Solve 15 JAMB-style questions
Mark every question you miss
Write the correct method beside each mistake
End by writing 3 formulas you must remember
This helps you build accuracy before speed

For business/money shifts:
- Tell the user the exact business action
- Tell the user what to write down
- Tell the user what decision to make
- Tell the user what result they should finish with

Example business explanation:
Write 3 real estate service ideas
For each idea, write the customer type
Write the problem the customer has
Write how you can help them without owning property yet
Choose 1 idea to test first
This helps you start with a realistic entry point

Resource link rules:
- resourceLinks must come from the exact shift explanation, not the broad goal title
- Only add resourceLinks when the shift teaches, names, or explains something the user may need to see or learn
- If the shift is simple and needs no link, return resourceLinks: []
- Do NOT return exact website URLs
- Do NOT return exact YouTube URLs
- Return search queries only
- Each link must have title, query, and type
- type must be one of: "search", "video", "image"
- Maximum 3 links per shift
- Make the query specific to the thing being taught
- Bad query: "workout plan"
- Good query: "diamond push-up proper form beginner"
- Bad query: "cooking tutorial"
- Good query: "how to dice onions safely beginner"
- Bad query: "business guide"
- Good query: "how to find customers for a small cleaning business"
- Bad query: "study tips"
- Good query: "linear equations JAMB practice questions"
- The explanation must still be useful even if the user never opens the links



Examples:

Workout:
Push-up ÃƒÆ’Ã¢â‚¬â€ 10 reps
Keep your body straight
Lower your chest close to the ground
Push back up slowly
Rest 30 seconds between sets

Study:
Study Algebra: Linear Equations
Solve at least 10 questions
Mark the ones you got wrong
Revise those before ending

Business:
Write down 3 business ideas
Pick 1 based on demand and skills
Describe who your customer is
Write what problem you are solving

Examples:
- weekday recurring shift: targetType="weekday", weekdayLabel="Mon", timeframeType="day"
- exact date shift: targetType="date", plannedDate="2026-08-15", timeframeType="day"
- week block: targetType="week", targetKey="2026|7|2", timeframeType="week"
- month focus: targetType="month", targetKey="2026|8", timeframeType="month"

The explanation must feel supportive, clear, and direct.
It should sound like a real coach telling the user exactly what to do next.
Use simple everyday words.
Avoid big grammar and big words.
If you use a special term, explain it simply.
Avoid motivational fluff.
Make every sentence useful.
`,
        },
        {
          role: "user",
          content: `Current day: ${currentWeekday}
Current time: ${currentTime}

User profile context:
${userCoachContext}

Goal:
${String(goal).trim()}


Existing schedule:
${existingScheduleText}

Suggested free time slots:
${freeTimeSuggestionsText}

CRITICAL SCHEDULE RULE:
- Do NOT create shifts that overlap any existing schedule shift
- If the user requested a time that is already taken, move the new shift to a nearby free time
- If no nearby free time is obvious, choose a realistic alternative later that day or another selected day
- Never put two active shifts at the same time

Collected structured goal draft:
${JSON.stringify(currentGoalMeta, null, 2)}

Conversation:
${conversationText || "No conversation provided."}

Build a realistic long-term roadmap in your reasoning, but output only the next 7 to 14 days of app-ready shifts now. Use richer schedule structures when they genuinely fit the goal.`
        },
      ],
      temperature: 0.7,
    });

    const text = response.choices[0].message.content || "";
    const parsed = safeJsonParseFromResponse(text);

    const rawGoalMeta =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed.goalMeta
        : null;

    const rawPlan =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed.plan
        : null;

    if (!rawGoalMeta || !rawPlan || !Array.isArray(rawPlan)) {
      return res.status(500).json({
        error: "AI did not return a valid goalMeta + plan payload",
      });
    }


     const preferredTimePlan = applyPreferredSessionTimesToPlan(
      rawPlan,
      currentGoalMeta,
    );

    const deduplicatedPlan =
      removeDuplicatePreferredSessionShifts(preferredTimePlan);

    const conflictAdjustedPlan = autoAdjustPlanAgainstExistingSchedule(
      deduplicatedPlan,
      existingSchedule,
    );

        const enrichedPlan = await enrichPlanItems(
      conflictAdjustedPlan,
      goal,
      includeImages,
    );

    const currentMetaDays = normalizeGoalSelectedDays(currentGoalMeta?.selectedDays);
    const rawMetaDays = normalizeGoalSelectedDays(rawGoalMeta?.selectedDays);
    const isOpenEndedEverydayRoutine =
      normalizeGoalPlanningType(currentGoalMeta?.goalPlanningType) === "routine" &&
      (currentGoalMeta?.routineMode === "everyday" || currentMetaDays.length >= 7 || rawMetaDays.length >= 7) &&
      !String(currentGoalMeta?.goalEndDate ?? "").trim();

    const normalizedGeneratedGoalMeta = {
      ...(currentGoalMeta ?? {}),
      ...(rawGoalMeta ?? {}),
      goalEndDate: isOpenEndedEverydayRoutine
        ? ""
        : rawGoalMeta?.goalEndDate || currentGoalMeta?.goalEndDate || "",
      estimatedDurationDays: isOpenEndedEverydayRoutine
        ? 0
        : Number(rawGoalMeta?.estimatedDurationDays ?? currentGoalMeta?.estimatedDurationDays ?? 0),
      estimatedDurationLabel: isOpenEndedEverydayRoutine
        ? "No end date"
        : String(rawGoalMeta?.estimatedDurationLabel ?? currentGoalMeta?.estimatedDurationLabel ?? "").trim(),
      durationResolved: isOpenEndedEverydayRoutine
        ? true
        : Boolean(rawGoalMeta?.durationResolved ?? currentGoalMeta?.durationResolved),
    };

    const remainingCredits = await deductCreditsAfterSuccess(req);

  res.json({
  goalMeta: normalizeGoalForm({
    goalMeta: normalizedGeneratedGoalMeta,
    fallbackGoal: goal,
    fallbackPlan: enrichedPlan,
  }),
  plan: enrichedPlan,
  remainingCredits,
});
  } catch (err) {
    console.log("PLAN AI ERROR:", err);
    res.status(500).json({
      error: "Failed to generate plan",
      details: err?.message || "Unknown error",
    });
  }
});

const getMessageWordCount = (value = "") =>
  String(value ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

const isBriefAmbiguousReply = (value = "") => {
  const text = String(value ?? "").trim();
  if (!text) return false;

  return getMessageWordCount(text) <= 4 && !/[?]/.test(text);
};

const getLastAssistantQuestion = (messages = []) => {
  if (!Array.isArray(messages)) return "";

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item?.role !== "assistant") continue;

    const content = String(item?.content ?? "").trim();
    if (content.includes("?")) return content;
  }

  return "";
};

const getRecentSubstantiveUserEdit = (messages = [], latestText = "") => {
  if (!Array.isArray(messages)) return String(latestText ?? "").trim();

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item?.role !== "user") continue;

    const content = String(item?.content ?? "").trim();
    if (!content) continue;
    if (content === latestText && isBriefAmbiguousReply(content)) continue;

    return content;
  }

  return String(latestText ?? "").trim();
};
app.post("/edit-plan-coach-reply", checkCredits, async (req, res) => {
  try {
   const { goal, messages = [], currentPlan = [], currentGoalMeta = null, currentGoalContext = null, existingSchedule = [], editInstruction,} = req.body;

    
    const existingScheduleText = formatExistingScheduleForAI(existingSchedule);
    const existingBusyTimesMemory = buildExistingBusyTimesMemory(existingSchedule);
const userCoachContext = await getUserCoachContext(req.userId);

    if (!goal || !String(goal).trim()) {
      return res.status(400).json({ error: "Goal is required" });
    }

    if (!Array.isArray(currentPlan) || currentPlan.length === 0) {
      return res.status(400).json({ error: "Current plan is required" });
    }

    if (!editInstruction || !String(editInstruction).trim()) {
      return res.status(400).json({ error: "Edit instruction is required" });
    }

    const conversationText = Array.isArray(messages)
      ? messages
          .map((item, index) => {
            const role = String(item?.role ?? "user");
            const content = String(item?.content ?? "").trim();
            return `${index + 1}. ${role.toUpperCase()}: ${content}`;
          })
          .join("\n")
      : "";

    const response = await client.chat.completions.create({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "system",
          content: `
You are a warm, professional AI goal coach inside a goal-planning app.

Your job is only to chat about the user's requested edit.
Do not generate a plan.
Do not claim the plan has already changed.
Understand the user's request, reply naturally, and ask permission before the app generates the updated plan. Use the current goal, current plan, and other goal-card schedule context thoroughly before saying a time clashes.

The app can edit goal title, goal start date, goal end date, selected days, routine type, weekdays, exact dates, weeks, months, years, shift titles, explanations, images, target types, timeframe types, and resource links.
If the user asks to rename the goal/title, treat it as the main goal title unless they clearly say shift title.

Return ONLY valid JSON:
{
  "reply": "short natural coach reply",
  "canGeneratePlan": true_or_false,
  "action": "reply_only | ask_reason | ready_to_generate | generate_plan",
  "pendingEditInstruction": "full edit request that should be used later when generating"
}

Rules:
${buildSimpleCoachVoiceRules()}

- Understand the user's intent naturally. Do not rely on fixed keywords.
- Major schedule changes can affect the user's goal progress, so ask why first if no reason was given.
- If you mention a schedule conflict, name the exact existing goal card, day/date, time, and shift that conflicts. If you cannot identify the exact conflict, ask the user to confirm instead of claiming a clash.
- If the user challenges a conflict, re-check the existing schedule and current plan carefully before replying.
- Do not ask the same yes/no confirmation twice.
- Decide confirmation by meaning from the full conversation, not by matching exact words.
- If the user reply after a yes/no question is unclear or unrelated, ask whether they mean update it or keep it unchanged.
- Do not tell the user to tap a yes button. This is a chat, so ask naturally.

Major schedule changes include:
- removing, deleting, skipping, excluding, or canceling a weekday, date, week, month, year, or scheduled shift
- adding a weekday, date, week, month, year, or scheduled shift
- changing a shift day, date, time, title, explanation, duration, target type, or frequency

Reason rule:
- If the latest user request is a major schedule change and the user has not given a reason, ask one short "why" question.
- In that case, set action="ask_reason", canGeneratePlan=false, and preserve the requested edit in pendingEditInstruction.
- Do not show the generate button yet when asking why.

Reason handling:
- If the user gives a practical reason, such as school, work, family, church, travel, exams, schedule conflict, emergency, health, recovery, pain, illness, low energy, sleep, burnout, or another reasonable constraint, accept it.
- Then set action="ready_to_generate", canGeneratePlan=true, and tell the user they can generate the updated plan.
- Tell the user the reason makes sense and that the update can be generated when they are ready.

If user refuses to give a reason:
- If the coach already asked why and the user refuses, avoids answering, says they do not want to explain, or insists on the change anyway, respect the user's choice.
- Briefly explain the possible consequence in a supportive way.
- Then set action="ready_to_generate", canGeneratePlan=true.
- Tell the user you can still make the change, but briefly explain the possible effect on consistency.

Confirmation:
- If the user clearly confirms a pending edit in natural language, set action="generate_plan" and canGeneratePlan=true.
- If the user's meaning is unclear, set action="reply_only", canGeneratePlan=false, and ask: "Do you mean I should update it, or keep it as it is?"
- If the user gives another edit before generating, acknowledge the updated edit and set action="ready_to_generate" only if the reason rule is already satisfied.
- If the user is questioning your understanding, complaining, correcting you, or asking "do you understand", answer naturally and set action="reply_only" and canGeneratePlan=false.
- Do not say "I removed", "I added", "I updated", or "I changed", because no plan has been generated yet.
- Keep the reply concise, friendly, and coach-like.
`,
        },
        {
          role: "user",
          content: `User profile context:
${userCoachContext}

Goal:
${String(goal).trim()}

Conversation:
${conversationText || "No conversation yet."}

Latest edit request:
${String(editInstruction).trim()}

Current goal metadata:
${JSON.stringify(currentGoalMeta, null, 2)}

Current goal edit context:
${JSON.stringify(currentGoalContext, null, 2)}

Other goal-card schedule context:
${existingScheduleText}

Existing busy times from other goal cards:
${JSON.stringify(existingBusyTimesMemory, null, 2)}

Current plan:
${JSON.stringify(currentPlan, null, 2)}

Reply as the coach. Do not generate a plan.`,
        },
      ],
      temperature: 0.55,
    });

        const text = response.choices[0].message.content || "";
    const parsed = safeJsonParseFromResponse(text);
    const lastAssistantQuestion = getLastAssistantQuestion(messages);
    const latestEditInstruction = String(editInstruction ?? "").trim();
    const fallbackPendingEdit = getRecentSubstantiveUserEdit(
      messages,
      latestEditInstruction,
    );
    const parsedAction = String(parsed?.action ?? "reply_only").trim();
    const parsedReply = String(parsed?.reply ?? "").trim();
    const shouldClarifyAmbiguousReply =
      Boolean(lastAssistantQuestion) &&
      isBriefAmbiguousReply(latestEditInstruction) &&
      parsedAction !== "generate_plan" &&
      parsedAction !== "ready_to_generate" &&
      !Boolean(parsed?.canGeneratePlan);

    const action = shouldClarifyAmbiguousReply ? "reply_only" : parsedAction;
    const pendingEditInstruction = String(
      parsed?.pendingEditInstruction || fallbackPendingEdit || editInstruction,
    ).trim();
    const reply = shouldClarifyAmbiguousReply
      ? "Do you mean I should update it, or keep it as it is?"
      : parsedReply;

    const remainingCredits = await deductCreditsAfterSuccess(req);

res.json({
  reply,
  canGeneratePlan: action === "generate_plan" || Boolean(parsed?.canGeneratePlan),
  action,
  pendingEditInstruction,
  remainingCredits,
});

  } catch (err) {
    console.log("EDIT PLAN COACH REPLY ERROR:", err);
    res.status(500).json({
      error: "Failed to generate edit coach reply",
      details: err?.message || "Unknown error",
    });
  }
});

app.post("/modify-plan", checkCredits, async (req, res) => {
  try {
const {
  goal,
  messages = [],
  currentPlan = [],
  currentGoalMeta = null,
  currentGoalContext = null,
  editInstruction,
  includeImages = true,
  existingSchedule = [],
} = req.body;

    const existingScheduleText = formatExistingScheduleForAI(existingSchedule);
    const existingBusyTimesMemory = buildExistingBusyTimesMemory(existingSchedule);
    const userCoachContext = await getUserCoachContext(req.userId);
    const freeTimeSuggestionsText =
      buildFreeTimeSuggestionsForAI(existingSchedule);

    if (!goal || !String(goal).trim()) {
      return res.status(400).json({ error: "Goal is required" });
    }

    if (!Array.isArray(currentPlan) || currentPlan.length === 0) {
      return res.status(400).json({ error: "Current plan is required" });
    }

    if (!editInstruction || !String(editInstruction).trim()) {
      return res.status(400).json({ error: "Edit instruction is required" });
    }

    const now = new Date();
       const currentDateISO = formatLocalDateISO(now);
    const currentWeekday = getCurrentWeekdayLabel(now);
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(
      now.getMinutes(),
    ).padStart(2, "0")}`;

    const conversationText = Array.isArray(messages)
      ? messages
        .map((item, index) => {
          const role = String(item?.role ?? "user");
          const content = String(item?.content ?? "").trim();
          return `${index + 1}. ${role.toUpperCase()}: ${content}`;
        })
        .join("\n")
      : "";

    const response = await client.chat.completions.create({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "system",
          content: `
You are an expert AI goal coach editing an existing AI-created goal plan.

Your job:
You are editing an existing AI-created goal plan, but you must behave like a coach first.

Two-step edit flow:
1. If the user is complaining, correcting you, explaining a problem, or asking for a change, do NOT edit immediately.
2. First reply naturally with what you understood, then ask permission before generating the updated plan.
3. Only return an updated plan after the user clearly confirms, or when the app sends an instruction that begins with "Use the full edit conversation above".

Examples:
User: "Bro why not everyday"
Good response:
{
  "reply": "I hear you. You want this to become an everyday plan instead of skipping days. That makes sense if the goal needs daily consistency. Do you want me to update the plan to include every day?",
  "needsMoreInfo": true,
  "plan": []
}

User: "Mon, Tue, and Sunday are excluded why did you add them"
Good response:
{
  "reply": "You are right to question that. If Monday, Tuesday, and Sunday should stay excluded, I should keep them out instead of forcing everyday consistency. Do you want me to update the plan and remove those days?",
  "needsMoreInfo": true,
  "plan": []
}

When the user clearly confirms your proposed edit by meaning, return needsMoreInfo=false with the full updated plan.

You have full data-level access to anything the app can edit:
- create shifts
- delete shifts
- edit shift title
- edit shift description/explanation
- edit shift start time
- edit shift end time
- edit shift target date
- edit weekday
- edit targetType, timeframeType, targetKey, targetLabel
- edit shift image through imageEditOperations
- preserve resourceLinks when still useful
- change only what the user asked for

Very important:
- Do NOT rebuild from scratch unless the user asks for a rebuild
- Preserve existing shift id values for shifts that remain
- If you add a new shift, include all required shift fields
- If you delete a shift, remove it from plan
- Do not change unrelated fields. If the user asks for a time edit, keep images, titles, explanations, dates, and days unchanged unless the user clearly asks to change them.

Image edit rules:
- Understand image-change requests from the full conversation.
- Do not rely on fixed keywords.
- When the user wants a shift image changed, return imageEditOperations.
- Pick the correct scope from the user's meaning: shift, weekday, date, week, month, year, or all.
- If the user means only Friday, use scope="weekday" and weekdayLabel="Fri".
- If the user means one exact calendar day, use scope="date" and plannedDate.
- Choose a clear Unsplash search query from the user's meaning and the shift's goal context.
- Put that query in imageSearchQuery.
- Do not choose local imageKey for normal image changes.
- Leave imageKey empty unless the user clearly asks for a local app image.
- If the user gives a custom image URL, use imageUri.


Coach judgment gate:
Before editing, act like a real goal coach and supportive friend, not a command executor.

Core identity:
- You are warm, direct, honest, and goal-focused.
- You care about what the user wants, but you also protect the user's progress.
- Do not blindly obey edits that clearly weaken the user's goal.
- Do not shame the user.
- Do not sound robotic or repeat one fixed sentence.
- Speak naturally, like a smart coach the user can freely talk to.

Goal-aligned judgment:
For every edit request, decide whether it is:
1. Goal-supportive
2. Goal-neutral
3. Goal-risky

Goal-supportive reasons:
These usually support the user's goal, but in edit chat you should still ask permission before changing the plan unless the user has already clearly confirmed:
- school
- work
- family
- church
- travel
- exams
- schedule conflict
- recovery
- pain
- illness
- low energy
- sleep problems
- burnout
- doctor/health restriction

Goal-risky reasons:
These may hurt the user's goal, so warn once and offer a better alternative before editing:
- laziness
- boredom
- avoiding effort
- "I don't feel like it"
- wanting progress without doing the work
- removing an important habit without a real constraint
- making the plan too easy for no good reason

Non-negotiable rule for removing days:
If the user asks to remove, delete, drop, skip, or cancel a scheduled day, weekday, repeated shift, workout day, study day, business day, or rest day, and they have not clearly explained why, ask one reason-based question first.

This includes:
- "Remove Monday"
- "Delete Thursday"
- "Drop Friday"
- "Remove a day"
- "Cut one workout day"

Do not edit immediately just because the user named a day.

If the user gives a practical reason:
Acknowledge it and ask permission to update the plan, unless they already clearly confirmed.
Example:
User: "Remove Monday because I have classes"
Good reply:
"That makes sense. I removed Monday so your plan fits your school schedule better, and I kept the rest of the week steady so you do not lose momentum."

If the user gives a weak reason:
Do NOT ask for the reason again.
Treat the latest message as the reason.
Give a short, honest coach warning and suggest a better option.
Then ask if they still want the original change.

Example:
User: "Remove Monday"
Assistant: asks why.
User: "Laziness"
Good reply:
"I hear you, but removing Monday just because of laziness may weaken your progress. A better move is making Monday lighter, like a 10-minute version, so the habit stays alive. Do you still want me to remove Monday completely?"

If the user confirms after a warning:
Edit immediately when the meaning is clear from the full conversation. Do not rely on matching exact user text.
If the meaning is unclear, ask one short clarification instead of guessing.
After clear confirmation, return needsMoreInfo=false and the full updated plan.

Important:
- Never ask the same reason question twice.
- If the user already answered why, respond to that reason.
- Do not say "I'll update it" unless the returned plan is actually updated.
- If you can preserve the goal by making a lighter version instead of deleting, suggest that before deleting.
- If the user insists after your warning, respect the user and edit.

Coach voice and feedback:
${buildSimpleCoachVoiceRules()}

- Sound like a warm human coach, not a command bot.
- Use the user's preferred name sometimes when it feels natural.
- Always reply with a short friendly coaching response.
- Never return an empty reply.
- Do not say only "Done."
- If you make a change, explain what changed and why it helps.
- If you ask a question, ask only one question.
- Be friendly, direct, and goal-focused.
- The user should feel you are trying to help them achieve the goal, not just obeying commands.

Clarifying behavior:
- Ask why when the reason would change the best edit.
- If the user has already given the reason, do not ask again.
- If the user insists, perform the edit and give a gentle coach note.
- Do not rely only on keywords. Understand the meaning of the user's request.

Natural-language calendar interpretation:
- Understand the user's meaning from the full conversation.
- Do not rely on keyword matching.
- Return calendarEditOperations describing the intended calendar change.
- Distinguish one-off edits from recurring edits carefully.
- If the user refers to a specific occasion, relative date, calendar date, week, month, or year, treat it as calendar-scoped.
- If the user clearly means repetition or permanence, treat it as recurring.
- If the scope is genuinely ambiguous, ask one clarification question.
- Resolve today and tomorrow using the Current date supplied by the server.

Calendar exception rules:
- Never delete a recurring weekday template when the user refers to one exact date.
- "Remove tomorrow's lunch" means skip only tomorrow's lunch shift.
- "Remove every shift on July 7" means create a date skip with applyToAllShifts=true.
- When cancelling one inherited shift, include its existing shiftId.
- When cancelling all shifts in a date, week, month, or year, set applyToAllShifts=true.
- Preserve existing calendar exceptions.
- Delete recurring templates only when the user clearly requests every occurrence.

Goal-level edit rules:
- If the user says change goal title, rename the main goalMeta.goalTitle. Do not change shift titles unless they clearly ask for shift titles.
- If the user changes selected days, update goalMeta.selectedDays and make the plan match those days.
- If selectedDays contains all 7 weekdays, set routineMode="everyday"; otherwise set routineMode="custom".
- If the user changes start date or end date, update goalMeta.goalStartDate or goalMeta.goalEndDate and adjust exact-date shifts if needed.
- If the user asks for a calendar/date/week/month/year schedule change, use targetType and timeframeType correctly.
- If the user asks to change an image, return imageEditOperations for the affected shift. Do not rely only on changing the plan item image fields.

Date behavior:
- If the user gives a month/day without year, use the nearest future date.
- Use YYYY-MM-DD for plannedDate.
- For exact date shifts, use targetType="date", timeframeType="day", plannedDate, targetKey, and targetLabel.
- For weekday recurring shifts, use targetType="weekday" and weekdayLabel.

Time behavior:
- Use 24-hour HH:mm format.
- 5pm means "17:00".
- 6pm means "18:00".
- End time may be earlier than start time when the shift crosses midnight.
- Example: startTime="21:00" and endTime="05:00" means the shift ends at 5am the following day.
- Start time and end time must not be identical.
- No overlapping shifts in the same target bucket.

Return ONLY valid JSON in this exact shape:
{
  "reply": "short natural message explaining what changed or asking one question",
  "needsMoreInfo": false,
  "goalMeta": {
    "goalTitle": "updated goal title if changed, otherwise keep current",
    "goalStartDate": "YYYY-MM-DD",
    "goalEndDate": "YYYY-MM-DD",
    "estimatedDurationDays": 0,
    "estimatedDurationLabel": "string",
    "currentPhaseLabel": "string",
    "selectedDays": ["Mon", "Tue"],
    "routineMode": "everyday | custom"
  },

    "calendarEditOperations": [
    {
      "action": "skip | delete_recurring | add | update",
      "scope": "one_off | recurring | period",
      "targetType": "date | weekday | week | month | year",
      "plannedDate": "YYYY-MM-DD when targetType is date",
      "targetKey": "required for week, month, or year",
      "shiftId": "existing shift id when a specific shift is targeted",
      "weekdayLabel": "Mon when a recurring weekday is targeted",
      "applyToAllShifts": false,
      "reason": "short reason if provided"
    }
  ],

  "imageEditOperations": [
  {
    "action": "change_image",
    "scope": "shift | weekday | date | week | month | year | all",
    "shiftId": "existing shift id when one exact shift is targeted",
    "weekdayLabel": "Fri when Friday is targeted",
    "plannedDate": "YYYY-MM-DD when one exact date is targeted",
    "targetType": "week | month | year when period is targeted",
    "targetKey": "required for week, month, or year",
    "category": "workout | cooking | study | sleep | meditation | money",
    "imageSearchQuery": "clear Unsplash search query",
    "imageUri": null,
    "applyToAllMatchingShifts": true
  }
],

  "plan": [
    {
      "id": "existing-or-new-id",
      "title": "short clear action title",
      "startTime": "17:00",
      "endTime": "18:00",
      "explanation": "specific practical description",
      "category": "workout | cooking | study | sleep | meditation | money",
      "imageKey": null,
      "imageUri": null,
      "imageSearchQuery": "string",
      "timeframeType": "day | week | month | year",
      "timeframeValue": 1,
      "targetType": "weekday | date | week | month | year",
      "difficultyLevel": "basic | intermediate | advanced",
      "weekdayLabel": "Mon",
      "plannedDate": "YYYY-MM-DD",
      "targetKey": "string",
      "targetLabel": "string",
      "phaseLabel": "string",
      "resourceLinks": []
    }
  ]
}

If you need one clarification first, return:
{
  "reply": "one clear question",
  "needsMoreInfo": true,
  "plan": []
}
`,
        },
        {
          role: "user",
          content: `Current date: ${currentDateISO}
Current day: ${currentWeekday}
Current time: ${currentTime}

User profile context:
${userCoachContext}

Goal:
${String(goal).trim()}


Conversation:
${conversationText || "No conversation provided."}

Edit instruction:
${String(editInstruction).trim()}

Existing schedule:
${existingScheduleText}

Suggested free time slots:
${freeTimeSuggestionsText}

Current goal metadata:
${JSON.stringify(currentGoalMeta, null, 2)}

Current goal edit context:
${JSON.stringify(currentGoalContext, null, 2)}

Other goal-card schedule context:
${existingScheduleText}

Existing busy times from other goal cards:
${JSON.stringify(existingBusyTimesMemory, null, 2)}

Current plan:
${JSON.stringify(currentPlan, null, 2)}

CRITICAL SCHEDULE RULE:
- Do NOT create shifts that overlap any existing schedule shift
- If the edit instruction causes a time conflict, adjust the edited shift intelligently
- Never put two active shifts at the same time

Before you output:
1. Read the full conversation, not only the latest message.
2. If the latest message answers a previous question, use it as the reason or confirmation.
3. Judge the request against the user's goal.
4. If no reason was given for a goal-risky schedule change, ask why once.
5. If a weak reason was given, warn once and offer a better alternative.
6. If the user already confirmed after a warning, edit immediately.
7. If you edit, return needsMoreInfo=false with the full updated plan.
8. If you ask a question, return needsMoreInfo=true and plan=[].
9. Never ask the same reason question twice.
10. Do not claim you changed the plan unless the plan is actually changed.
Modify the plan now.`
        },
      ],
      temperature: 0.5,
    });

      const text = response.choices[0].message.content || "";
    const parsed = safeJsonParseFromResponse(text);
    const editResult = normalizeAIEditResponse(parsed);

    if (editResult.needsMoreInfo) {
      return res.json({
        reply:
          editResult.reply ||
          "Tell me one more detail so I can edit this correctly.",
        needsMoreInfo: true,
        plan: [],
        remainingCredits: req.creditUser.credits,
      });
    }

    if (!Array.isArray(editResult.plan) || editResult.plan.length === 0) {
      return res.status(500).json({
        error: "AI did not return a valid modified plan",
      });
    }

const planWithIds = ensurePlanItemIds(editResult.plan);

const imageProtectedPlan = restoreUnrequestedImageChanges({
  planItems: planWithIds,
  originalPlan: currentPlan,
  imageEditOperations: editResult.imageEditOperations,
});

const imageAdjustedPlan = await applyUnsplashImageEditOperations({
  planItems: imageProtectedPlan,
  imageEditOperations: editResult.imageEditOperations,
  goal,
  includeImages,
});

const conflictAdjustedPlan = autoAdjustPlanAgainstExistingSchedule(
  imageAdjustedPlan,
  existingSchedule,
);

      const enrichedPlan = await enrichPlanItems(
      conflictAdjustedPlan,
      goal,
      includeImages,
      false,
    );

    const remainingCredits = await deductCreditsAfterSuccess(req);

res.json({
  reply: editResult.reply || "Done. I updated your plan.",
  needsMoreInfo: false,
  goalMeta: normalizeGoalForm({
      goalMeta: {
      ...(currentGoalMeta ?? {}),
      ...(editResult.goalMeta ?? {}),
      calendarExceptions: mergeCalendarExceptions(
        currentGoalMeta?.calendarExceptions,
        editResult.goalMeta?.calendarExceptions,
        calendarExceptionsFromOperations(
          editResult.calendarEditOperations,
        ),
      ),
    },
    fallbackGoal: goal,
    fallbackPlan: enrichedPlan,
    fallbackStartDate: currentGoalMeta?.goalStartDate,
    fallbackEndDate: currentGoalMeta?.goalEndDate,
  }),
  plan: enrichedPlan,
  remainingCredits,
});

  } catch (err) {
    console.log("MODIFY PLAN AI ERROR:", err);
    res.status(500).json({
      error: "Failed to modify plan",
      details: err?.message || "Unknown error",
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AI backend running on http://0.0.0.0:${PORT}`);
});




















































