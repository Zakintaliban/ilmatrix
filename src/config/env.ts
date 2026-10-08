import "dotenv/config";

/** Where the client's IP comes from (only headers a trusted proxy overwrites are safe). */
export type ClientIpHeader = "x-real-ip" | "cf-connecting-ip" | "x-forwarded-for" | "none";

function getEnvClientIpHeader(): ClientIpHeader {
  const value = (process.env.CLIENT_IP_HEADER || "x-real-ip").trim().toLowerCase();
  if (value === "x-real-ip" || value === "cf-connecting-ip" || value === "x-forwarded-for" || value === "none") {
    return value;
  }
  console.warn(`[CONFIG] Unknown CLIENT_IP_HEADER "${value}"; using x-real-ip`);
  return "x-real-ip";
}

export interface AppConfig {
  // Server Configuration
  port: number;
  host: string;

  // Groq Configuration
  groqApiKey: string;
  groqModel: string;
  groqFallbackModel: string;
  groqVisionModel: string;
  groqReasoningEffort: "none" | "low" | "medium" | "high";
  groqStructuredOutputs: boolean;
  groqConcurrency: number;
  groqTimeoutMs: number;

  // Material Configuration
  materialClamp: number;
  materialTtlMinutes: number;
  materialUserRetentionDays: number;
  materialUserQuotaBytes: number;

  // Rate Limiting
  rateLimitMax: number;
  rateLimitWindowMs: number;

  // AI endpoints, per user (guests: per device, or per IP without a device cookie)
  aiRateLimitPerMinute: number;
  aiRateLimitPerHour: number;
  aiMaxConcurrent: number;

  // Client IP & guest abuse protection
  clientIpHeader: ClientIpHeader;
  turnstileSiteKey: string;
  turnstileSecretKey: string;
  guestIpDailyVerifications: number;
  guestIpDailyRequests: number;

  // File Processing
  pdfMaxPages: number;

  // Upload Configuration
  uploadMaxSizeBytes: number;
  uploadsDir: string;

  // Database Configuration
  databaseUrl?: string;
  databasePublicUrl?: string;
  pgHost?: string;
  pgPort?: string;
  pgDatabase?: string;
  pgUser?: string;
  pgPassword?: string;

  // Email Configuration
  resendApiKey?: string;
  emailFromAddress?: string;
  baseUrl: string;

  // Google OAuth Configuration
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;

  // Payments (Midtrans Snap)
  midtransServerKey: string;
  midtransIsProduction: boolean;
  /** Snap payment methods to offer (empty = everything active on the merchant account). */
  midtransEnabledPayments: string[];
  /** Webhook URL sent per transaction (X-Override-Notification); empty = the dashboard setting. */
  midtransNotificationUrl: string;

  // Environment Detection
  isNetlify: boolean;
  isDevelopment: boolean;
  isProduction: boolean;
}

function getEnvString(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (!value && defaultValue === undefined) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value || defaultValue || "";
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a valid number`);
  }
  return parsed;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return /^(true|1|yes|on)$/i.test(value);
}

/**
 * Model IDs Groq has shut down, mapped to the replacement Groq recommends.
 * Existing deployments may still set these explicitly in GROQ_MODEL.
 */
const RETIRED_GROQ_MODELS: Record<string, string> = {
  "meta-llama/llama-4-maverick-17b-128e-instruct": "openai/gpt-oss-120b",
  "meta-llama/llama-4-scout-17b-16e-instruct": "openai/gpt-oss-120b",
  "moonshotai/kimi-k2-instruct": "openai/gpt-oss-120b",
  "moonshotai/kimi-k2-instruct-0905": "openai/gpt-oss-120b",
  "qwen/qwen3-32b": "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile": "openai/gpt-oss-120b",
  "llama-3.1-8b-instant": "openai/gpt-oss-20b",
  "groq/compound": "openai/gpt-oss-120b",
  "groq/compound-mini": "openai/gpt-oss-20b",
};

export function resolveGroqModel(key: string, model: string): string {
  const replacement = RETIRED_GROQ_MODELS[model];
  if (!replacement) return model;
  console.warn(
    `[CONFIG] ${key}=${model} has been retired by Groq; using ${replacement} instead. Update your environment.`
  );
  return replacement;
}

/** Like getEnvString, but an explicitly empty value disables the feature. */
function getEnvOptional(key: string, defaultValue: string): string {
  const value = process.env[key];
  return value === undefined ? defaultValue : value.trim();
}

function getEnvReasoningEffort(key: string, defaultValue: AppConfig["groqReasoningEffort"]): AppConfig["groqReasoningEffort"] {
  const value = (process.env[key] || "").trim().toLowerCase();
  return value === "none" || value === "low" || value === "medium" || value === "high"
    ? value
    : defaultValue;
}

export const config: AppConfig = {
  // Server Configuration
  port: getEnvNumber("PORT", 8787),
  host: getEnvString("HOST", "localhost"),

  // Groq Configuration
  groqApiKey: getEnvString("GROQ_API_KEY", ""),
  // meta-llama/llama-4-maverick-17b-128e-instruct was retired by Groq on 2026-03-09.
  groqModel: resolveGroqModel("GROQ_MODEL", getEnvString("GROQ_MODEL", "openai/gpt-oss-120b")),
  // Used when the primary model is rate limited, down or decommissioned. Empty disables.
  groqFallbackModel: resolveGroqModel(
    "GROQ_FALLBACK_MODEL",
    getEnvOptional("GROQ_FALLBACK_MODEL", "openai/gpt-oss-20b")
  ),
  // gpt-oss is text-only; images go here. Preview model on Groq. Empty disables vision.
  groqVisionModel: getEnvOptional("GROQ_VISION_MODEL", "qwen/qwen3.8-27b"),
  groqReasoningEffort: getEnvReasoningEffort("GROQ_REASONING_EFFORT", "medium"),
  groqStructuredOutputs: getEnvBoolean("GROQ_STRUCTURED_OUTPUTS", true),
  groqConcurrency: Math.max(1, getEnvNumber("GROQ_CONCURRENCY", 4)),
  groqTimeoutMs: Math.max(1000, getEnvNumber("GROQ_TIMEOUT_MS", 45000)),

  // Material Configuration
  materialClamp: Math.max(4000, getEnvNumber("MATERIAL_CLAMP", 100000)),
  // Guest materials expire this long after last use
  materialTtlMinutes: Math.max(1, getEnvNumber("MATERIAL_TTL_MINUTES", 60)),
  // Signed-in users' materials (Postgres) expire this long after last use; saved ones never do
  materialUserRetentionDays: Math.max(1, getEnvNumber("MATERIAL_USER_RETENTION_DAYS", 180)),
  materialUserQuotaBytes: Math.max(1, getEnvNumber("MATERIAL_USER_QUOTA_MB", 200)) * 1024 * 1024,

  // Rate Limiting
  rateLimitMax: Math.max(1, getEnvNumber("RATE_LIMIT_MAX", 120)),
  rateLimitWindowMs: 60_000, // 1 minute

  // AI endpoints: sliding-window caps and requests in flight per user/guest device.
  // Kredit bounds spend; these keep one client from flooding the shared Groq queue.
  aiRateLimitPerMinute: Math.max(1, getEnvNumber("AI_RATE_LIMIT_PER_MINUTE", 12)),
  aiRateLimitPerHour: Math.max(1, getEnvNumber("AI_RATE_LIMIT_PER_HOUR", 150)),
  aiMaxConcurrent: Math.max(1, getEnvNumber("AI_MAX_CONCURRENT", 2)),

  // Client IP & guest abuse protection
  // Railway's edge overwrites X-Real-IP; behind Cloudflare's proxy use cf-connecting-ip
  clientIpHeader: getEnvClientIpHeader(),
  // Cloudflare Turnstile: guests must pass it before using AI (disabled unless both are set)
  turnstileSiteKey: getEnvString("TURNSTILE_SITE_KEY", "").trim(),
  turnstileSecretKey: getEnvString("TURNSTILE_SECRET_KEY", "").trim(),
  // Per client IP per day: new guest devices verified, and guest AI requests
  guestIpDailyVerifications: Math.max(1, getEnvNumber("GUEST_IP_DAILY_VERIFICATIONS", 20)),
  guestIpDailyRequests: Math.max(1, getEnvNumber("GUEST_IP_DAILY_REQUESTS", 100)),

  // File Processing
  pdfMaxPages: getEnvNumber("PDF_MAX_PAGES", 200),

  // Upload Configuration
  uploadMaxSizeBytes: 10 * 1024 * 1024, // 10MB
  uploadsDir: process.env.NETLIFY ? "/tmp/uploads" : process.cwd() + "/uploads",

  // Database Configuration
  // Railway provides DATABASE_URL via service variable in private network (production)
  // For local development, use DATABASE_LOCAL_URL or fallback to public URL
  databaseUrl: process.env.DATABASE_URL || process.env.DATABASE_LOCAL_URL,
  databasePublicUrl: process.env.DATABASE_PUBLIC_URL,
  pgHost: process.env.PGHOST,
  pgPort: process.env.PGPORT,
  pgDatabase: process.env.PGDATABASE,
  pgUser: process.env.PGUSER,
  pgPassword: process.env.PGPASSWORD,

  // Email Configuration
  resendApiKey: process.env.RESEND_API_KEY,
  emailFromAddress: process.env.EMAIL_FROM_ADDRESS || "noreply@ilmatrix.com",
  baseUrl: process.env.BASE_URL || "http://localhost:8787",

  // Google OAuth Configuration
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || `${process.env.BASE_URL || "http://localhost:8787"}/api/auth/google/callback`,

  // Payments (Midtrans Snap). Disabled until MIDTRANS_SERVER_KEY is set.
  midtransServerKey: getEnvString("MIDTRANS_SERVER_KEY", "").trim(),
  midtransIsProduction: getEnvBoolean("MIDTRANS_IS_PRODUCTION", false),
  midtransEnabledPayments: getEnvString("MIDTRANS_ENABLED_PAYMENTS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Default: our webhook, but only for a public HTTPS BASE_URL (Midtrans can't reach localhost)
  midtransNotificationUrl: getEnvString(
    "MIDTRANS_NOTIFICATION_URL",
    /^https:\/\//.test(process.env.BASE_URL || "") ? `${process.env.BASE_URL}/api/payments/midtrans/notification` : ""
  ).trim(),

  // Environment Detection
  isNetlify: !!process.env.NETLIFY,
  isDevelopment: process.env.NODE_ENV === "development",
  isProduction: process.env.NODE_ENV === "production",
};

// Validate critical configuration
if (!config.groqApiKey && config.isProduction) {
  console.warn(
    "Warning: GROQ_API_KEY is not set. AI features will be limited."
  );
}

if (config.isProduction && !(config.turnstileSiteKey && config.turnstileSecretKey)) {
  console.warn(
    "Warning: TURNSTILE_SITE_KEY/TURNSTILE_SECRET_KEY are not set. Guest AI is protected only by per-IP caps."
  );
}

// Sandbox server keys start with "SB-"; a mismatch means payments hit the wrong Midtrans environment
if (config.midtransServerKey && config.midtransServerKey.startsWith("SB-") === config.midtransIsProduction) {
  console.warn(
    `Warning: MIDTRANS_IS_PRODUCTION=${config.midtransIsProduction} but MIDTRANS_SERVER_KEY looks like a ` +
      `${config.midtransServerKey.startsWith("SB-") ? "sandbox" : "production"} key.`
  );
}

export default config;
