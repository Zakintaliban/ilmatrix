import Groq from "groq-sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { createLimiter, type Limiter } from "../utils/concurrency.js";
import config from "../config/env.js";

/**
 * Single place that knows how to talk to Groq: model routing, reasoning
 * parameters, structured outputs, fallback, error mapping and usage capture.
 * Study-tool prompts live in groqService.ts and only call `complete()`.
 */

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface JsonSchemaFormat {
  name: string;
  schema: Record<string, unknown>;
}

export interface CompletionRequest {
  messages: any[];
  temperature?: number;
  /** Budget for the visible answer; reasoning headroom is added per model. */
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  /** Request schema-constrained JSON output (falls back automatically). */
  json?: JsonSchemaFormat;
  /** Route to the vision model (messages contain image parts). */
  vision?: boolean;
}

export interface CompletionResult {
  content: string;
  model: string;
  usage: TokenUsage | null;
}

/** Minimal surface of the Groq SDK we depend on (lets tests inject a fake). */
export interface ChatClient {
  chat: {
    completions: {
      create(params: any, options?: any): Promise<any>;
    };
  };
}

export interface ProviderConfig {
  apiKey: string;
  model: string;
  fallbackModel: string;
  visionModel: string;
  reasoningEffort: ReasoningEffort;
  structuredOutputs: boolean;
  timeoutMs: number;
  concurrency: number;
}

export type AIErrorCode =
  | "not_configured"
  | "vision_unavailable"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "too_large"
  | "bad_request"
  | "unknown";

const USER_MESSAGES: Record<AIErrorCode, string> = {
  not_configured:
    "Fitur AI belum aktif: GROQ_API_KEY belum dikonfigurasi di server.",
  vision_unavailable:
    "Analisis gambar sedang tidak tersedia. Coba lagi nanti atau kirim teksnya.",
  rate_limited:
    "Layanan AI sedang sangat sibuk. Tunggu sebentar lalu coba lagi.",
  timeout: "AI terlalu lama merespons. Coba lagi, atau persingkat pertanyaanmu.",
  unavailable: "Layanan AI sedang tidak tersedia. Coba lagi beberapa saat lagi.",
  too_large:
    "Materi atau percakapan terlalu panjang untuk diproses sekaligus. Kurangi materi lalu coba lagi.",
  bad_request: "Permintaan ke AI tidak valid. Coba ubah pertanyaanmu lalu kirim lagi.",
  unknown: "Terjadi kesalahan pada layanan AI. Coba lagi.",
};

export class AIServiceError extends Error {
  readonly code: AIErrorCode;
  readonly userMessage: string;

  constructor(code: AIErrorCode, detail?: string) {
    super(detail ? `${USER_MESSAGES[code]} (${detail})` : USER_MESSAGES[code]);
    this.name = "AIServiceError";
    this.code = code;
    this.userMessage = USER_MESSAGES[code];
  }
}

/**
 * Circuit breaker: only provider-side failures (429/5xx/timeouts) count, so a
 * user sending oversized or invalid input cannot open it for everyone.
 */
class GroqCircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private readonly failureThreshold = 5;
  private readonly recoveryTimeoutMs = 60_000;

  assertClosed(): void {
    if (this.failures < this.failureThreshold) return;
    if (Date.now() - this.openedAt > this.recoveryTimeoutMs) {
      this.failures = this.failureThreshold - 1; // half-open: one probe
      return;
    }
    throw new AIServiceError("unavailable", "circuit open");
  }

  onSuccess(): void {
    this.failures = 0;
  }

  onProviderFailure(): void {
    this.failures++;
    if (this.failures >= this.failureThreshold) {
      this.openedAt = Date.now();
      console.warn(`[GROQ] Circuit opened after ${this.failures} consecutive provider failures`);
    }
  }
}

// ---------------------------------------------------------------------------
// Request-scoped usage capture
// ---------------------------------------------------------------------------

interface UsageStore {
  usage: TokenUsage | null;
  model: string | null;
}

const usageStorage = new AsyncLocalStorage<UsageStore>();

/**
 * Run `fn` and return the token usage of every Groq completion it made.
 * Usage is scoped to this call, so concurrent requests never see each other's
 * usage, and a call that fails reports no usage.
 */
export async function trackUsage<T>(
  fn: () => Promise<T>
): Promise<{ result: T; usage: TokenUsage | null; model: string | null }> {
  const store: UsageStore = { usage: null, model: null };
  const result = await usageStorage.run(store, fn);
  return { result, usage: store.usage, model: store.model };
}

function recordUsage(store: UsageStore | undefined, result: CompletionResult): void {
  if (!store) return;
  store.model = result.model;
  if (!result.usage) return;
  const prev = store.usage;
  store.usage = {
    prompt_tokens: (prev?.prompt_tokens || 0) + result.usage.prompt_tokens,
    completion_tokens: (prev?.completion_tokens || 0) + result.usage.completion_tokens,
    total_tokens: (prev?.total_tokens || 0) + result.usage.total_tokens,
  };
}

// ---------------------------------------------------------------------------
// Model capabilities
// ---------------------------------------------------------------------------

type ModelFamily = "gpt-oss" | "qwen" | "other";

function modelFamily(model: string): ModelFamily {
  if (model.startsWith("openai/gpt-oss")) return "gpt-oss";
  if (model.startsWith("qwen/")) return "qwen";
  return "other";
}

const REASONING_HEADROOM: Record<ReasoningEffort, number> = {
  none: 0,
  low: 1024,
  medium: 2048,
  high: 4096,
};

export function buildParams(model: string, req: CompletionRequest, cfg: ProviderConfig): any {
  const family = modelFamily(model);
  const effort = req.reasoningEffort || cfg.reasoningEffort;
  const visible = req.maxOutputTokens || 1500;

  const params: any = {
    model,
    messages: req.messages,
    temperature: req.temperature ?? 0.3,
  };

  if (family === "gpt-oss") {
    // gpt-oss supports low|medium|high; reasoning is billed as output tokens.
    const gptEffort = effort === "none" ? "low" : effort;
    params.reasoning_effort = gptEffort;
    params.include_reasoning = false;
    params.max_completion_tokens = visible + REASONING_HEADROOM[gptEffort];
  } else if (family === "qwen") {
    params.reasoning_effort = effort;
    params.reasoning_format = "hidden";
    params.max_completion_tokens = visible + REASONING_HEADROOM[effort];
  } else {
    params.max_completion_tokens = visible;
  }

  if (req.json) {
    params.response_format =
      cfg.structuredOutputs && family !== "other"
        ? {
            type: "json_schema",
            json_schema: { name: req.json.name, schema: req.json.schema, strict: true },
          }
        : { type: "json_object" };
  }

  return params;
}

/**
 * When Groq rejects an optional parameter, step it down instead of failing:
 * json_schema -> json_object -> prompt-only, then drop reasoning params.
 */
function downgradeParams(params: any, err: unknown): boolean {
  const msg = errorText(err);
  if (params.response_format && /response_format|json_schema|json_object|json_validate|structured output/.test(msg)) {
    if (params.response_format.type === "json_schema") {
      params.response_format = { type: "json_object" };
    } else {
      delete params.response_format;
    }
    return true;
  }
  for (const key of ["reasoning_effort", "include_reasoning", "reasoning_format"]) {
    if (key in params && msg.includes(key)) {
      delete params[key];
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function errorText(err: unknown): string {
  const e = err as any;
  return `${e?.message || ""} ${e?.error ? JSON.stringify(e.error) : ""}`.toLowerCase();
}

function statusOf(err: unknown): number | undefined {
  const status = (err as any)?.status;
  return typeof status === "number" ? status : undefined;
}

function isTimeout(err: unknown): boolean {
  const name = (err as any)?.constructor?.name || (err as any)?.name || "";
  return name === "APIConnectionTimeoutError" || /timed out|timeout/.test(errorText(err));
}

function isModelUnavailable(err: unknown): boolean {
  const status = statusOf(err);
  const msg = errorText(err);
  return (
    status === 404 ||
    /model_decommissioned|decommissioned|model_not_found|model_terminated/.test(msg) ||
    (/model/.test(msg) && /does not exist|not found|not available|no access/.test(msg))
  );
}

/** Failures caused by the provider rather than the request itself. */
function isProviderFailure(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  if (status === undefined) return true; // connection errors and timeouts
  return isModelUnavailable(err);
}

export function toAIServiceError(err: unknown, vision = false): AIServiceError {
  if (err instanceof AIServiceError) return err;
  const status = statusOf(err);
  if (vision && (isModelUnavailable(err) || status === 400)) {
    return new AIServiceError("vision_unavailable");
  }
  if (isTimeout(err)) return new AIServiceError("timeout");
  if (status === 429) return new AIServiceError("rate_limited");
  if (status === 413 || /context_length|maximum context|too large|reduce the length/.test(errorText(err))) {
    return new AIServiceError("too_large");
  }
  if (status === 401 || status === 403) return new AIServiceError("unavailable", "auth");
  if (isModelUnavailable(err) || status === undefined || status >= 500) {
    return new AIServiceError("unavailable");
  }
  if (status === 400 || status === 422) return new AIServiceError("bad_request");
  return new AIServiceError("unknown");
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

function defaultConfig(): ProviderConfig {
  return {
    apiKey: config.groqApiKey,
    model: config.groqModel,
    fallbackModel: config.groqFallbackModel,
    visionModel: config.groqVisionModel,
    reasoningEffort: config.groqReasoningEffort,
    structuredOutputs: config.groqStructuredOutputs,
    timeoutMs: config.groqTimeoutMs,
    concurrency: config.groqConcurrency,
  };
}

export class GroqProvider {
  readonly cfg: ProviderConfig;
  private client: ChatClient | null;
  private readonly injected: boolean;
  private readonly limiter: Limiter;
  private readonly breaker = new GroqCircuitBreaker();

  constructor(opts: { client?: ChatClient; config?: Partial<ProviderConfig> } = {}) {
    this.cfg = { ...defaultConfig(), ...opts.config };
    this.injected = !!opts.client;
    this.client = opts.client || null;
    this.limiter = createLimiter(Math.max(1, this.cfg.concurrency));
  }

  get isConfigured(): boolean {
    return this.injected || !!this.cfg.apiKey;
  }

  get hasVision(): boolean {
    return !!this.cfg.visionModel;
  }

  private getClient(): ChatClient {
    if (!this.client) {
      // The SDK enforces the timeout (and aborts the request); fallback to the
      // secondary model replaces SDK-level retries so latency stays bounded.
      this.client = new Groq({
        apiKey: this.cfg.apiKey,
        timeout: this.cfg.timeoutMs,
        maxRetries: 0,
      });
    }
    return this.client;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.isConfigured) {
      throw new AIServiceError("not_configured");
    }
    if (req.vision && !this.hasVision) {
      throw new AIServiceError("vision_unavailable");
    }

    // Capture the caller's usage scope now: the limiter may start this job
    // from another request's async context.
    const store = usageStorage.getStore();

    const models = req.vision
      ? [this.cfg.visionModel]
      : [this.cfg.model, this.cfg.fallbackModel].filter(
          (m, i, all) => !!m && all.indexOf(m) === i
        );

    let lastError: unknown;
    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      try {
        this.breaker.assertClosed();
        const result = await this.limiter(() => this.completeWithModel(model, req));
        this.breaker.onSuccess();
        recordUsage(store, result);
        return result;
      } catch (err) {
        lastError = err;
        if (err instanceof AIServiceError) throw err;
        const providerFailure = isProviderFailure(err);
        if (providerFailure) this.breaker.onProviderFailure();
        const hasNext = i < models.length - 1;
        console.error(
          `[GROQ] ${model} failed (status ${statusOf(err) ?? "n/a"})${hasNext && providerFailure ? `, falling back to ${models[i + 1]}` : ""}:`,
          (err as any)?.message || err
        );
        if (!providerFailure || !hasNext) break;
      }
    }
    throw toAIServiceError(lastError, req.vision);
  }

  private async completeWithModel(model: string, req: CompletionRequest): Promise<CompletionResult> {
    const params = buildParams(model, req, this.cfg);

    for (let attempt = 0; ; attempt++) {
      try {
        const completion = await this.getClient().chat.completions.create(params);
        const content = completion?.choices?.[0]?.message?.content || "";
        const u = completion?.usage;
        const usage: TokenUsage | null = u
          ? {
              prompt_tokens: u.prompt_tokens || 0,
              completion_tokens: u.completion_tokens || 0,
              total_tokens: u.total_tokens || 0,
            }
          : null;
        if (usage) {
          console.log(
            `[GROQ] ${model} tokens: ${usage.total_tokens} (prompt: ${usage.prompt_tokens}, completion: ${usage.completion_tokens})`
          );
        }
        return { content, model: completion?.model || model, usage };
      } catch (err) {
        if (statusOf(err) === 400 && attempt < 3 && downgradeParams(params, err)) {
          console.warn(`[GROQ] ${model} rejected an optional parameter; retrying with a simpler request`);
          continue;
        }
        throw err;
      }
    }
  }
}
