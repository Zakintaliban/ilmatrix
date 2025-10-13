import "dotenv/config";

export interface AppConfig {
  // Server Configuration
  port: number;
  host: string;

  // Groq Configuration
  groqApiKey: string;
  groqModel: string;
  groqConcurrency: number;
  groqTimeoutMs: number;

  // Material Configuration
  materialClamp: number;
  materialTtlMinutes: number;

  // Rate Limiting
  rateLimitMax: number;
  rateLimitWindowMs: number;

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

export const config: AppConfig = {
  // Server Configuration
  port: getEnvNumber("PORT", 8787),
  host: getEnvString("HOST", "localhost"),

  // Groq Configuration
  groqApiKey: getEnvString("GROQ_API_KEY", ""),
  groqModel: getEnvString(
    "GROQ_MODEL",
    "meta-llama/llama-4-maverick-17b-128e-instruct"
  ),
  groqConcurrency: Math.max(1, getEnvNumber("GROQ_CONCURRENCY", 4)),
  groqTimeoutMs: Math.max(1000, getEnvNumber("GROQ_TIMEOUT_MS", 45000)),

  // Material Configuration
  materialClamp: Math.max(4000, getEnvNumber("MATERIAL_CLAMP", 100000)),
  materialTtlMinutes: Math.max(1, getEnvNumber("MATERIAL_TTL_MINUTES", 60)),

  // Rate Limiting
  rateLimitMax: Math.max(1, getEnvNumber("RATE_LIMIT_MAX", 120)),
  rateLimitWindowMs: 60_000, // 1 minute

  // File Processing
  pdfMaxPages: getEnvNumber("PDF_MAX_PAGES", 200),

  // Upload Configuration
  uploadMaxSizeBytes: 10 * 1024 * 1024, // 10MB
  uploadsDir: process.env.NETLIFY ? "/tmp/uploads" : process.cwd() + "/uploads",

  // Database Configuration
  databaseUrl: process.env.DATABASE_URL,
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

export default config;
