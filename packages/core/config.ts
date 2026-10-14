import dotenv from "dotenv";
import path from "node:path";
dotenv.config({ quiet: true });
export const config = {
  mode: process.env.APP_MODE === "live" ? "live" : "demo",
  port: Number(process.env.PORT || 8000),
  appUrl: process.env.APP_URL || "http://localhost:3000",
  workerUrl: process.env.WORKER_URL || "http://127.0.0.1:8000",
  dataDir: path.resolve(process.env.DATA_DIR || "./data"),
  tinyfishKey: process.env.TINYFISH_API_KEY || "",
  geminiKeys: [
    ...new Set(
      (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
        .split(/[,\s]+/)
        .filter(Boolean),
    ),
  ],
  model: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
  classificationModel:
    process.env.GEMINI_CLASSIFICATION_MODEL ||
    process.env.GEMINI_MODEL ||
    "gemini-3.5-flash-lite",
  publicDemoUrl: process.env.PUBLIC_DEMO_URL || "",
};
export const capabilities = () => ({
  mode: config.mode,
  tinyfish: !!config.tinyfishKey,
  intelligence: config.geminiKeys.length > 0,
  intelligenceProvider: "gemini",
  intelligenceKeyCount: config.geminiKeys.length,
  google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  supabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
  email: !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM),
  voice: !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER
  ),
  publicDemo: !!config.publicDemoUrl,
  storage: "local SQLite + encrypted files",
});
