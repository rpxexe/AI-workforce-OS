import { z } from "zod";
import { e164 } from "./voice.ts";

export const EMPLOYEE_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

/** Icon keys; the dashboard maps each to an icon. */
export const AVATARS = ["bot", "headset", "briefcase", "sparkles", "shield", "cart", "calendar", "wrench"] as const;

export const LANGUAGES = {
  en: "English",
  "en-IN": "English (India)",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
  hi: "Hindi",
  // Callers and writers who switch between Hindi and English: speech recognition listens for both.
  "hi-en": "Hindi + English (Hinglish)",
  ar: "Arabic",
  ja: "Japanese",
  zh: "Chinese",
} as const;

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

const daySchema = z
  .object({ day: z.enum(DAYS), enabled: z.boolean(), start: time, end: time })
  .refine((d) => !d.enabled || d.start < d.end, { path: ["end"], message: "End must be after start" });

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const workingHoursSchema = z.object({
  timezone: z.string().refine(isTimeZone, "Unknown time zone"),
  days: z
    .array(daySchema)
    .length(7)
    .refine((days) => days.every((d, i) => d.day === DAYS[i]), "Days must be Monday to Sunday, in order"),
});

const MEMORY_KEY = /^[a-z][a-z0-9_]{0,49}$/;
export const HANDOFF_RULE_OPERATORS = ["contains", "equals", "at_least", "at_most"] as const;

/** A configured condition that hands a conversation to people: on the customer's message, or on a fact remembered about them. */
export const handoffRuleSchema = z
  .object({
    field: z.enum(["message", "memory"]),
    /** The memory key (e.g. plan), when `field` is memory. */
    key: z.string().trim().max(50),
    operator: z.enum(HANDOFF_RULE_OPERATORS),
    value: z.string().trim().min(1, "Enter a value").max(200),
  })
  .refine((r) => r.field === "message" || MEMORY_KEY.test(r.key), { path: ["key"], message: "Enter a memory key, like plan" })
  .refine((r) => (r.operator !== "at_least" && r.operator !== "at_most") || Number.isFinite(Number(r.value)), {
    path: ["value"],
    message: "Enter a number",
  });
export type HandoffRule = z.infer<typeof handoffRuleSchema>;

export const escalationSchema = z
  .object({
    /** Hands conversations to people on the triggers below; people can take over from the inbox either way. */
    enabled: z.boolean(),
    /** Told by email about every handoff. */
    contactEmail: z.union([z.literal(""), z.email("Enter a valid email")]),
    onCustomerRequest: z.boolean(),
    /** The employee judges it cannot answer reliably. */
    onLowConfidence: z.boolean(),
    /** The employee judges an answer could break policy (legal, medical, refunds beyond policy, threats). */
    onPolicyRisk: z.boolean(),
    /** A tool the employee used failed. */
    onToolFailure: z.boolean(),
    /** Hand off after this many failed attempts to help; 0 turns the trigger off. */
    afterFailedAttempts: z.number().int().min(0).max(10),
    /** High-value customers: a remembered number (e.g. budget) at or above the minimum. Empty key turns it off. */
    highValueKey: z.union([z.literal(""), z.string().trim().regex(MEMORY_KEY, "Use a memory key, like budget")]),
    highValueMinimum: z.number().min(0),
    rules: z.array(handoffRuleSchema).max(10),
    handoffMessage: z.string().trim().max(500),
    /** Phone calls handed off are transferred to this number (a person or a team line); empty: the employee hangs up and someone calls back. */
    transferNumber: z.union([z.literal(""), e164]),
    /** Alert people again (and remind the contact by email) when nobody takes a handed-off conversation within this many minutes; 0 never reminds. */
    reminderMinutes: z.number().int().min(0, "Use 0 to turn reminders off").max(240, "Use at most 240 minutes").default(0),
  })
  .refine((e) => !e.enabled || e.contactEmail !== "", {
    path: ["contactEmail"],
    message: "Add a contact email, or turn escalation off",
  });

/** Everything about an employee that is versioned. Shared by the dashboard form and the API. */
export const employeeConfigSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().trim().max(500),
  role: z.string().trim().min(1, "Role is required").max(80),
  personality: z.string().trim().max(2000),
  systemInstructions: z.string().trim().max(20000),
  goals: z.array(z.string().trim().min(1, "Goal cannot be empty").max(200)).max(20),
  language: z.enum(Object.keys(LANGUAGES) as [keyof typeof LANGUAGES, ...(keyof typeof LANGUAGES)[]]),
  avatar: z.enum(AVATARS),
  workingHours: workingHoursSchema,
  escalation: escalationSchema,
});
export type EmployeeConfig = z.infer<typeof employeeConfigSchema>;

export const defaultEmployeeConfig = (timezone = "UTC"): EmployeeConfig => ({
  name: "",
  description: "",
  role: "",
  personality: "",
  systemInstructions: "",
  goals: [],
  language: "en",
  avatar: "bot",
  workingHours: {
    timezone,
    days: DAYS.map((day, i) => ({ day, enabled: i < 5, start: "09:00", end: "17:00" })),
  },
  escalation: defaultEscalation(),
});

/** Also fills in settings added after a version was saved. */
export const defaultEscalation = (): EmployeeConfig["escalation"] => ({
  enabled: false,
  contactEmail: "",
  onCustomerRequest: true,
  onLowConfidence: true,
  onPolicyRisk: true,
  onToolFailure: false,
  afterFailedAttempts: 3,
  highValueKey: "",
  highValueMinimum: 0,
  rules: [],
  handoffMessage: "",
  transferNumber: "",
  reminderMinutes: 0,
});

export const publishSchema = z.object({ version: z.number().int().positive() });
/** DRAFT is not settable: it only describes an employee that has never been published. */
export const setStatusSchema = z.object({ status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]) });

// ---- API responses (dates are ISO strings) ----

export type EmployeeVersion = EmployeeConfig & { number: number; createdBy: string; createdAt: string };

export type EmployeeSummary = Pick<EmployeeConfig, "name" | "role" | "description" | "avatar" | "language"> & {
  id: string;
  status: EmployeeStatus;
  latestVersion: number;
  /** Version number serving production, or null if never published. */
  publishedVersion: number | null;
  updatedAt: string;
};

export type EmployeeDetail = {
  id: string;
  status: EmployeeStatus;
  publishedVersion: number | null;
  createdAt: string;
  updatedAt: string;
  /** Newest first; never empty. */
  versions: EmployeeVersion[];
};
