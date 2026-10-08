import type { ChatClient } from "../../src/services/groqProvider.js";

/**
 * In-memory stand-in for the Groq SDK client. Each call to
 * chat.completions.create() is recorded and answered by `handler`.
 */
export interface FakeCall {
  params: any;
}

export type FakeHandler = (params: any, callIndex: number) => any | Promise<any>;

export function createFakeGroq(handler: FakeHandler) {
  const calls: FakeCall[] = [];
  const client: ChatClient = {
    chat: {
      completions: {
        async create(params: any) {
          // Snapshot params: the provider mutates them when downgrading
          calls.push({ params: JSON.parse(JSON.stringify(params)) });
          return handler(params, calls.length - 1);
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
