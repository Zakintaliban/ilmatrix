import type { ChatClient } from "../../src/services/groqProvider.js";

/**
 * In-memory stand-in for the Groq SDK client. Each call to
 * chat.completions.create() is recorded and answered by `handler`.
 */
export interface FakeCall {
  params: any;
  options?: { signal?: AbortSignal };
}

export type FakeHandler = (params: any, callIndex: number, options?: { signal?: AbortSignal }) => any | Promise<any>;

export function createFakeGroq(handler: FakeHandler) {
  const calls: FakeCall[] = [];
  const client: ChatClient = {
    chat: {
      completions: {
        async create(params: any, options?: { signal?: AbortSignal }) {
          // Snapshot params: the provider mutates them when downgrading
          calls.push({ params: JSON.parse(JSON.stringify(params)), options });
          return handler(params, calls.length - 1, options);
        },
      },
    },
  };
  return { client, calls };
}

/** Shape of a successful Groq chat completion. */
export function completion(content: string, usage = { prompt: 100, completion: 50 }, model?: string) {
  return {
    model,
    choices: [{ message: { role: "assistant", content } }],
    usage: {
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
      total_tokens: usage.prompt + usage.completion,
    },
  };
}

export interface FakeStreamOptions {
  /** Final chunk's x_groq.usage; null = no usage reported. */
  usage?: { prompt: number; completion: number } | null;
  /** Wait before each chunk (lets tests abort mid-stream). */
  delayMs?: number;
  /** Throw this after the given number of content pieces. */
  failAfter?: { pieces: number; error: unknown };
  /** Send x_groq.error after the content (Groq stopping the stream). */
  groqError?: string;
  /** Reasoning deltas sent before the content (must never reach the client). */
  reasoning?: string[];
  /** Stop sending after this many pieces and hang (stalled stream). */
  hangAfter?: number;
  signal?: AbortSignal;
}

function abortError() {
  return Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
}

/** Shape of a streamed Groq completion: content deltas, then usage in x_groq. */
export async function* streamOf(pieces: string[], opts: FakeStreamOptions = {}) {
  const wait = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (opts.signal?.aborted) return reject(abortError());
      const timer = setTimeout(resolve, ms);
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(abortError());
      }, { once: true });
    });

  for (const r of opts.reasoning ?? []) {
    yield { choices: [{ index: 0, delta: { reasoning: r }, finish_reason: null }] };
  }
  for (let i = 0; i < pieces.length; i++) {
    if (opts.hangAfter !== undefined && i >= opts.hangAfter) await wait(60_000);
    if (opts.failAfter && i >= opts.failAfter.pieces) throw opts.failAfter.error;
    if (opts.delayMs) await wait(opts.delayMs);
    else if (opts.signal?.aborted) throw abortError();
    yield { choices: [{ index: 0, delta: { content: pieces[i] }, finish_reason: null }] };
  }
  if (opts.groqError) {
    yield { choices: [{ index: 0, delta: {}, finish_reason: null }], x_groq: { error: opts.groqError } };
    return;
  }
  const usage = opts.usage === undefined ? { prompt: 300, completion: 40 } : opts.usage;
  yield {
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    ...(usage
      ? { x_groq: { id: "req_test", usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion } } }
      : {}),
  };
}

/** Error shaped like groq-sdk's APIError (status + JSON body). */
export function apiError(status: number, message: string, code?: string) {
  const body = { error: { message, type: "invalid_request_error", code } };
  const err: any = new Error(`${status} ${JSON.stringify(body)}`);
  err.status = status;
  err.error = body;
  return err;
}

/** Error shaped like groq-sdk's APIConnectionTimeoutError. */
export function timeoutError() {
  class APIConnectionTimeoutError extends Error {}
  return new APIConnectionTimeoutError("Request timed out.");
}

export const TEST_PROVIDER_CONFIG = {
  apiKey: "test-key",
  model: "openai/gpt-oss-120b",
  fallbackModel: "openai/gpt-oss-20b",
  visionModel: "qwen/qwen3.8-27b",
  reasoningEffort: "medium" as const,
  structuredOutputs: true,
  timeoutMs: 5000,
  concurrency: 4,
};

/** A material block exactly as extractionService stores a text-less image. */
export function imageMaterial(name: string, payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==") {
  return `===== FILE: ${name} =====
[IMAGE: ${name}]
Type: image/png
Size: 1KB
Encoding: base64
Note: This image has no extractable text. Image data is preserved for visual analysis.

Base64 Data:
data:image/png;base64,${payload}

Vision API can analyze this image when queried.`;
}
