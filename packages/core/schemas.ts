import { z } from "zod";
export const ProfileSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().max(30).default(""),
  headline: z.string().max(200).default(""),
  education: z.string().max(2000).default(""),
  skills: z.array(z.string().max(80)).max(100).default([]),
  projects: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        skills: z.array(z.string()).default([]),
        url: z.string().default(""),
      }),
    )
    .max(30)
    .default([]),
  links: z
    .object({
      linkedin: z.string().default(""),
      github: z.string().default(""),
      portfolio: z.string().default(""),
    })
    .default({}),
  preferences: z
    .object({
      keywords: z.string().default("Python backend internship"),
      location: z.string().default("India"),
      remoteOnly: z.boolean().default(false),
      minStipend: z.number().min(0).default(0),
      availableMonths: z.number().min(0).max(24).default(3),
      graduationYear: z.number().nullable().default(null),
    })
    .default({}),
  alerts: z
    .object({
      email: z.boolean().default(false),
      voice: z.boolean().default(false),
      quietStart: z.number().min(0).max(23).default(22),
      quietEnd: z.number().min(0).max(23).default(8),
      timezone: z.string().default("Asia/Kolkata"),
    })
    .default({}),
  answersBank: z.record(z.string()).default({}),
  resumeId: z.string().nullable().default(null),
});
export type Profile = z.infer<typeof ProfileSchema>;
export const ListingSchema = z.object({
  title: z.string().min(1),
  company: z.string().min(1),
  url: z.string().url(),
  applyUrl: z.string().url(),
  description: z.string(),
  location: z.string().nullable(),
  workMode: z.enum(["remote", "hybrid", "onsite", "unknown"]),
  stipendAmount: z.number().nullable(),
  currency: z.string().nullable(),
  paymentPeriod: z.enum(["month", "week", "hour", "total", "unknown"]),
  deadline: z.string().nullable(),
  durationMonths: z.number().nullable(),
  skillsMust: z.array(z.string()),
  skillsNice: z.array(z.string()).default([]),
  eligibility: z.string().nullable(),
  evidence: z.record(z.string()).default({}),
  rawText: z.string().default(""),
  provenance: z.enum(["demo", "live"]),
  status: z.enum(["open", "expired", "closed", "unknown"]).default("unknown"),
});
export type Listing = z.infer<typeof ListingSchema>;
export type Field = {
  label: string;
  type: string;
  required: boolean;
  options: string[];
  section?: string | null;
  selector?: string;
};
export type FormMap = {
  form_url: string;
  blocker: "none" | "captcha" | "login_required" | "blocked" | "closed";
  steps: number;
  fields: Field[];
};
export type Answer = { value: string; source: string; confidence: number };
export type AppRecord = {
  id: string;
  userId: string;
  listingId: string;
  status: string;
  provenance: string;
  controlledTarget?: boolean;
  route: "web" | "email" | "outreach";
  formMap?: FormMap;
  answers?: Record<string, Answer>;
  gaps?: Field[];
  package?: {
    resumeId: string;
    coverLetterId?: string;
    coverLetter: string;
    emailSubject?: string;
    recipient?: string;
  };
  verification?: {
    errors: string[];
    warnings: string[];
    filled: any[];
    skipped: string[];
  };
  readback?: any[];
  screenshotId?: string;
  confirmationId?: string;
  session?: {
    session_id: string;
    cdp_url?: string;
    base_url?: string;
    expiresAt: string;
  };
  approvalHash?: string;
  actionAttempted?: boolean;
  submissionStartedAt?: string;
  submittedAt?: string;
  receipt?: any;
  employerStatus?: string;
  employerStatusAt?: string;
  lastCheckedAt?: string;
  error?: string;
  streamingUrl?: string;
  tfRunId?: string;
  updatedAt: string;
  createdAt: string;
};
export const FormMapOutput = {
  type: "object",
  properties: {
    form_url: { type: "string" },
    blocker: {
      type: "string",
      enum: ["none", "captcha", "login_required", "blocked", "closed"],
    },
    steps: { type: "integer" },
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          type: { type: "string" },
          required: { type: "boolean" },
          options: { type: "array", items: { type: "string" } },
          section: { type: "string", nullable: true },
        },
        required: ["label", "type", "required", "options"],
      },
    },
  },
  required: ["form_url", "blocker", "fields", "steps"],
};
export function sanitizeOutputSchema(value: any): any {
  if (Array.isArray(value)) return value.map(sanitizeOutputSchema);
  if (!value || typeof value !== "object") return value;
  const out: any = {};
  for (const [key, v] of Object.entries(value)) {
    if (["additionalProperties", "$schema", "oneOf", "const"].includes(key))
      continue;
    if (key === "type" && Array.isArray(v)) {
      out.type = v.find((x) => x !== "null");
      out.nullable = v.includes("null");
    } else out[key] = sanitizeOutputSchema(v);
  }
  return out;
}
