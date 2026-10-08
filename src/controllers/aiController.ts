import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { AIServiceError, groqService, type ChatMessage, type StreamResult } from "../services/groqService.js";
import type { StreamOptions } from "../services/groqProvider.js";
import { mcqScoringService } from "../services/mcqScoringService.js";
import { materialService } from "../services/materialService.js";
import { updateTokenUsageAfterRequest } from "../middleware/tokenUsageMiddleware.js";

/** Chat history limits: bound prompt size and keep the system prompt server-owned. */
const MAX_CHAT_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_HISTORY_CHARS = 60_000;

/**
 * Keep only user/assistant turns (clients must not supply system prompts),
 * truncate oversized messages and drop the oldest turns beyond the budget.
 */
export function sanitizeChatMessages(raw: unknown[]): ChatMessage[] {
  const messages: ChatMessage[] = raw
    .filter(
      (m: any) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim()
    )
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }))
    .slice(-MAX_CHAT_MESSAGES);

  let total = messages.reduce((n, m) => n + m.content.length, 0);
  while (messages.length > 1 && total > MAX_HISTORY_CHARS) {
    total -= messages.shift()!.content.length;
  }
  return messages;
}

/** Signed-in user making the request (owned materials are only readable by their owner). */
function requestUserId(c: Context): string | null {
  return c.get("user")?.id ?? null;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(Math.max(min, n), max) : fallback;
}

/** Keep-alive comment interval: proxies may close an idle connection while the model reasons. */
const KEEP_ALIVE_MS = 15_000;

/**
 * Stream an AI answer as Server-Sent Events:
 *   event: start  {}
 *   event: delta  {"text": "..."}             (repeated)
 *   event: done   {"answer", "token_usage", "usage_warning"}
 *   event: error  {"error", "code"}           (instead of done)
 * Validation, auth, kredit and rate limits run before the stream opens and
 * answer with normal JSON errors. Kredit is charged when the stream ends
 * (estimated if the student leaves early); the AI rate-limit slot is held
 * until then through `streamDone`.
 */
function streamAnswer(c: Context, task: string, produce: (opts: StreamOptions) => Promise<StreamResult>) {
  let finished!: () => void;
  c.set("streamDone", new Promise<void>((resolve) => (finished = resolve)));
  // Ask reverse proxies (nginx-style) not to buffer the event stream
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    const keepAlive = setInterval(() => void stream.write(": keep-alive\n\n").catch(() => {}), KEEP_ALIVE_MS);
    const send = (event: string, data: unknown) =>
      stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {
        // client gone; the abort handler stops generation
      });

    try {
      await send("start", {});
      const { result, usage, model, kredit } = await groqService.track(() =>
        produce({ signal: abort.signal, onDelta: (text) => void send("delta", { text }) })
      );

      let usageWarning: string | undefined;
      if (usage) {
        const tracking = await updateTokenUsageAfterRequest(
          c,
          usage.total_tokens,
          {
            model: model || groqService.getModelName(),
            kredit,
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            task,
            streamed: true,
            ...(result.aborted ? { aborted: true } : {}),
            ...(result.estimated ? { estimated: true } : {}),
          },
          { setHeaders: false }
        );
        usageWarning = tracking.warning;
      }
      if (!result.aborted) {
        await send("done", { answer: result.content, token_usage: usage, usage_warning: usageWarning });
      }
    } catch (error) {
      const known = error instanceof AIServiceError;
      if (!known) console.error(`[AI] ${task} stream failed:`, error);
      await send("error", {
        error: known ? error.userMessage : "Terjadi kesalahan pada layanan AI. Coba lagi.",
        code: known ? error.code : "unknown",
      });
    } finally {
      clearInterval(keepAlive);
      finished();
    }
  });
}

export class AIController {
  /**
   * Handle general AI requests (explain, quiz, forum, exam)
   */
  async handleAIRequest(
    c: Context,
    task: "explain" | "quiz" | "forum" | "exam"
  ) {
    try {
      const body = await c.req.json();
      const { materialId, materialText, prompt } = body;

      if (!materialId && !materialText) {
        return c.json({ error: "materialId or materialText is required" }, 400);
      }

      const material = await materialService.readMaterial(
        materialId,
        materialText,
        requestUserId(c)
      );

      if (!material.trim()) {
        return c.json({ error: "No material content found" }, 400);
      }

      if (body.stream === true) {
        return streamAnswer(c, task, (opts) => groqService.streamAnswer({ materialText: material, task, prompt }, opts));
      }

      const { result: answer, usage: tokenUsage, model, kredit } = await groqService.track(() =>
        groqService.generateAnswer({
          materialText: material,
          task,
          prompt,
        })
      );

      // Track token usage for registered users
      if (tokenUsage) {
        const trackingResult = await updateTokenUsageAfterRequest(c, tokenUsage.total_tokens, {
          model: model || groqService.getModelName(),
          kredit,
          prompt_tokens: tokenUsage.prompt_tokens,
          completion_tokens: tokenUsage.completion_tokens,
          task,
        });

        // Include usage info and warning in response
        return c.json({
          answer,
          token_usage: tokenUsage,
          usage_warning: trackingResult.warning,
        });
      }

      return c.json({ answer });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 500);
    }
  }

  /**
   * Handle chat requests
   */
  async handleChat(c: Context) {
    try {
      const body = await c.req.json();
      const { materialId, materialText, messages } = body;

      if (!Array.isArray(messages)) {
        return c.json({ error: "Messages array is required" }, 400);
      }

      const chatMessages = sanitizeChatMessages(messages);
      if (!chatMessages.length) {
        return c.json({ error: "Messages must include at least one user or assistant message" }, 400);
      }

      const material =
        materialId || materialText
          ? await materialService.readMaterial(materialId, materialText, requestUserId(c))
          : "";

      if (body.stream === true) {
        return streamAnswer(c, "chat", (opts) => groqService.streamChat({ materialText: material, messages: chatMessages }, opts));
      }

      const { result: answer, usage: tokenUsage, model, kredit } = await groqService.track(() =>
        groqService.generateChat({
          materialText: material,
          messages: chatMessages,
        })
      );

      // Track token usage for registered users
      if (tokenUsage) {
        const trackingResult = await updateTokenUsageAfterRequest(c, tokenUsage.total_tokens, {
          model: model || groqService.getModelName(),
          kredit,
          prompt_tokens: tokenUsage.prompt_tokens,
          completion_tokens: tokenUsage.completion_tokens,
          task: 'chat',
        });

        return c.json({
          answer,
          token_usage: tokenUsage,
          usage_warning: trackingResult.warning,
        });
      }

      return c.json({ answer });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 500);
    }
  }

  /**
   * Generate MCQ questions
   */
  async generateMCQ(c: Context) {
    try {
      const body = await c.req.json();
      const { materialId, materialText } = body;
      const numQuestions = clampInt(body.numQuestions, 5, 1, 50);

      if (!materialId && !materialText) {
        return c.json({ error: "materialId or materialText is required" }, 400);
      }

      const material = await materialService.readMaterial(
        materialId,
        materialText,
        requestUserId(c)
      );

      if (!material.trim()) {
        return c.json({ error: "No material content found" }, 400);
      }

      const { result: questions, usage: tokenUsage, model, kredit } = await groqService.track(() =>
        groqService.generateQuizTrainerMCQ({
          materialText: material,
          numQuestions, // Limited to 1-50 questions
        })
      );

      // Track token usage for registered users
      if (tokenUsage) {
        const trackingResult = await updateTokenUsageAfterRequest(c, tokenUsage.total_tokens, {
          model: model || groqService.getModelName(),
          kredit,
          prompt_tokens: tokenUsage.prompt_tokens,
          completion_tokens: tokenUsage.completion_tokens,
          task: 'quiz',
          num_questions: numQuestions,
        });

        return c.json({
          questions,
          token_usage: tokenUsage,
          usage_warning: trackingResult.warning,
        });
      }

      return c.json({ questions });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 500);
    }
  }

  /**
   * Score MCQ answers
   */
  async scoreMCQ(c: Context) {
    try {
      const body = await c.req.json();
      const { materialId, materialText, questions, userAnswers } = body;

      if (!Array.isArray(questions)) {
        return c.json({ error: "Questions array is required" }, 400);
      }

      if (!userAnswers || typeof userAnswers !== "object") {
        return c.json({ error: "User answers object is required" }, 400);
      }

      const result = mcqScoringService.scoreQuiz(questions, userAnswers);
      return c.json({ analysis: result.analysis });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 500);
    }
  }

  /**
   * Generate flashcards
   */
  async generateFlashcards(c: Context) {
    try {
      const body = await c.req.json();
      const { materialId, materialText } = body;
      const numCards = clampInt(body.numCards, 10, 1, 50);

      if (!materialId && !materialText) {
        return c.json({ error: "materialId or materialText is required" }, 400);
      }

      const material = await materialService.readMaterial(
        materialId,
        materialText,
        requestUserId(c)
      );

      if (!material.trim()) {
        return c.json({ error: "No material content found" }, 400);
      }

      const { result: cards, usage: tokenUsage, model, kredit } = await groqService.track(() =>
        groqService.generateFlashcards({
          materialText: material,
          numCards, // Limited to 1-50 cards
        })
      );

      // Track token usage for registered users
      if (tokenUsage) {
        const trackingResult = await updateTokenUsageAfterRequest(c, tokenUsage.total_tokens, {
          model: model || groqService.getModelName(),
          kredit,
          prompt_tokens: tokenUsage.prompt_tokens,
          completion_tokens: tokenUsage.completion_tokens,
          task: 'flashcards',
          num_cards: numCards,
        });

        return c.json({
          cards,
          token_usage: tokenUsage,
          usage_warning: trackingResult.warning,
        });
      }

      return c.json({ cards });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 500);
    }
  }

  // Dialogue feature methods
  async startDialogue(c: Context) {
    try {
      const { materialId, materialText } = await c.req.json();
      if (!materialId && !materialText) {
        return c.json({ error: "materialId or materialText is required" }, 400);
      }
      const text = await materialService.readMaterial(materialId, materialText, requestUserId(c));

      const { result, usage: tokenUsage, model, kredit } = await groqService.track(() =>
        groqService.dialogueStart({ materialText: text })
      );

      // Track token usage for registered users
      if (tokenUsage) {
        await updateTokenUsageAfterRequest(c, tokenUsage.total_tokens, {
          model: model || groqService.getModelName(),
          kredit,
          prompt_tokens: tokenUsage.prompt_tokens,
          completion_tokens: tokenUsage.completion_tokens,
          task: 'dialogue_start',
        });
      }

      // Frontend keeps session; we attach a pseudo id for convenience
      return c.json({ sessionId: crypto.randomUUID(), ...result });
    } catch (error) {
      console.error("Dialogue start error:", error);
      return c.json(
        {
          error: "Dialogue start failed",
          detail: error instanceof Error ? error.message : String(error),
        },
        500
      );
    }
  }

  async stepDialogue(c: Context) {
    try {
      const {
        materialId,
        materialText,
        topics,
        currentTopicIndex,
        userMessage,
        lastCoachQuestion,
        language,
      } = await c.req.json();

      if (!materialId && !materialText) {
        return c.json({ error: "materialId or materialText is required" }, 400);
      }
      if (!Array.isArray(topics) || !topics.length) {
        return c.json({ error: "topics array is required" }, 400);
      }
      if (typeof userMessage !== "string" || !userMessage.trim()) {
        return c.json({ error: "userMessage is required" }, 400);
      }

      const text = await materialService.readMaterial(materialId, materialText, requestUserId(c));

      // Special checkpoint: "How am I doing?"
      const isHowAmIDoing =
        typeof userMessage === "string" &&
        /^\s*how\s+am\s+i\s+doing\??\s*$/i.test(userMessage);

      if (isHowAmIDoing) {
        const total = Array.isArray(topics) ? topics.length : 3;
        const currentIdx = Math.max(
          0,
          Math.min(Number(currentTopicIndex || 0), total - 1)
        );
        const title =
          (Array.isArray(topics) &&
            topics[currentIdx] &&
            topics[currentIdx].title) ||
          (language === "id" ? "topik saat ini" : "the current topic");

        // If we're on the last topic and just received congratulations,
        // we've completed all topics
        const isOnLastTopic = currentIdx >= total - 1;
        const justGotCongrats =
          lastCoachQuestion &&
          /congratulations|congrats|completed|well done|excellent/i.test(
            lastCoachQuestion
          );

        let completed;
        if (isOnLastTopic && justGotCongrats) {
          // We've just completed the final topic
          completed = total;
          const msg =
            language === "id"
              ? `Selamat! Kamu telah menyelesaikan semua ${total} topik diskusi dengan baik!`
              : `Congratulations! You have successfully completed all ${total} discussion topics!`;
          return c.json({
            addressed: false,
            moveToNext: false,
            coachMessage: msg,
          });
        } else {
          // We've completed all topics before the current one we're working on
          completed = currentIdx;
          const msg =
            language === "id"
              ? `Kamu telah menyelesaikan ${completed} dari ${total} topik, dan saat ini kita membahas "${title}". Untuk melanjutkan: ${
                  lastCoachQuestion || "silakan jawab pertanyaan terakhir."
                }`
              : `You've completed ${completed} of ${total} topics, and we are currently working on "${title}". To pick up where we left off: ${
                  lastCoachQuestion || "please respond to the last question."
                }`;
          return c.json({
            addressed: false,
            moveToNext: false,
            coachMessage: msg,
          });
        }
      }

      const { result, usage: tokenUsage, model, kredit } = await groqService.track(() =>
        groqService.dialogueStep({
          materialText: text,
          topics,
          currentTopicIndex: clampInt(currentTopicIndex, 0, 0, topics.length - 1),
          userMessage,
          lastCoachQuestion,
          language,
        })
      );

      // Track token usage for registered users
      if (tokenUsage) {
        await updateTokenUsageAfterRequest(c, tokenUsage.total_tokens, {
          model: model || groqService.getModelName(),
          kredit,
          prompt_tokens: tokenUsage.prompt_tokens,
          completion_tokens: tokenUsage.completion_tokens,
          task: 'dialogue_step',
        });
      }

      return c.json(result);
    } catch (error) {
      console.error("Dialogue step error:", error);
      return c.json(
        {
          error: "Dialogue step failed",
          detail: error instanceof Error ? error.message : String(error),
        },
        500
      );
    }
  }

  async hintDialogue(c: Context) {
    try {
      const { materialId, materialText, currentTopicTitle, language } =
        await c.req.json();

      if (!materialId && !materialText) {
        return c.json({ error: "materialId or materialText is required" }, 400);
      }
      if (typeof currentTopicTitle !== "string" || !currentTopicTitle.trim()) {
        return c.json({ error: "currentTopicTitle is required" }, 400);
      }

      const text = await materialService.readMaterial(materialId, materialText, requestUserId(c));

      const { result, usage: tokenUsage, model, kredit } = await groqService.track(() =>
        groqService.dialogueHint({
          materialText: text,
          currentTopicTitle,
          language,
        })
      );

      // Track token usage for registered users
      if (tokenUsage) {
        await updateTokenUsageAfterRequest(c, tokenUsage.total_tokens, {
          model: model || groqService.getModelName(),
          kredit,
          prompt_tokens: tokenUsage.prompt_tokens,
          completion_tokens: tokenUsage.completion_tokens,
          task: 'dialogue_hint',
        });
      }

      return c.json(result);
    } catch (error) {
      console.error("Dialogue hint error:", error);
      return c.json(
        {
          error: "Dialogue hint failed",
          detail: error instanceof Error ? error.message : String(error),
        },
        500
      );
    }
  }

  async feedbackDialogue(c: Context) {
    try {
      const { materialId, materialText, topics, history, language } =
        await c.req.json();

      if (!materialId && !materialText) {
        return c.json({ error: "materialId or materialText is required" }, 400);
      }
      if (!Array.isArray(topics)) {
        return c.json({ error: "topics array is required" }, 400);
      }

      const text = await materialService.readMaterial(materialId, materialText, requestUserId(c));

      const { result, usage: tokenUsage, model, kredit } = await groqService.track(() =>
        groqService.dialogueFeedback({
          materialText: text,
          topics,
          history: Array.isArray(history) ? history : [],
          language,
        })
      );

      // Track token usage for registered users
      if (tokenUsage) {
        await updateTokenUsageAfterRequest(c, tokenUsage.total_tokens, {
          model: model || groqService.getModelName(),
          kredit,
          prompt_tokens: tokenUsage.prompt_tokens,
          completion_tokens: tokenUsage.completion_tokens,
          task: 'dialogue_feedback',
        });
      }

      return c.json(result);
    } catch (error) {
      console.error("Dialogue feedback error:", error);
      return c.json(
        {
          error: "Dialogue feedback failed",
          detail: error instanceof Error ? error.message : String(error),
        },
        500
      );
    }
  }
}

export const aiController = new AIController();
