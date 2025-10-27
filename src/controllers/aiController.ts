import type { Context } from "hono";
import { groqService } from "../services/groqService.js";
import { mcqScoringService } from "../services/mcqScoringService.js";
import { materialService } from "../services/materialService.js";
import { updateTokenUsageAfterRequest } from "../middleware/tokenUsageMiddleware.js";

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
        materialText
      );

      if (!material.trim()) {
        return c.json({ error: "No material content found" }, 400);
      }

      const answer = await groqService.generateAnswer({
        materialText: material,
        task,
        prompt,
      });

      // Track token usage for registered users
      const tokenUsage = groqService.getLastTokenUsage();
      if (tokenUsage) {
        const trackingResult = await updateTokenUsageAfterRequest(c, tokenUsage.total_tokens, {
          model: groqService.getModelName(),
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

      const material =
        materialId || materialText
          ? await materialService.readMaterial(materialId, materialText)
          : "";

      const answer = await groqService.generateChat({
        materialText: material,
        messages,
      });

      // Track token usage for registered users
      const tokenUsage = groqService.getLastTokenUsage();
      if (tokenUsage) {
        const trackingResult = await updateTokenUsageAfterRequest(c, tokenUsage.total_tokens, {
          model: groqService.getModelName(),
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
      const { materialId, materialText, numQuestions = 5 } = body;

      if (!materialId && !materialText) {
        return c.json({ error: "materialId or materialText is required" }, 400);
      }

      const material = await materialService.readMaterial(
        materialId,
        materialText
      );

      if (!material.trim()) {
        return c.json({ error: "No material content found" }, 400);
      }

      const questions = await groqService.generateQuizTrainerMCQ({
        materialText: material,
        numQuestions: Math.min(Math.max(1, numQuestions), 50), // Limit 1-50 questions
      });

      // Track token usage for registered users
      const tokenUsage = groqService.getLastTokenUsage();
      if (tokenUsage) {
        const trackingResult = await updateTokenUsageAfterRequest(c, tokenUsage.total_tokens, {
          model: groqService.getModelName(),
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
      const { materialId, materialText, numCards = 10 } = body;

      if (!materialId && !materialText) {
        return c.json({ error: "materialId or materialText is required" }, 400);
      }

      const material = await materialService.readMaterial(
        materialId,
        materialText
      );

      if (!material.trim()) {
        return c.json({ error: "No material content found" }, 400);
      }

      const cards = await groqService.generateFlashcards({
        materialText: material,
        numCards: Math.min(Math.max(1, numCards), 50), // Limit 1-50 cards
      });

      // Track token usage for registered users
      const tokenUsage = groqService.getLastTokenUsage();
      if (tokenUsage) {
        const trackingResult = await updateTokenUsageAfterRequest(c, tokenUsage.total_tokens, {
          model: groqService.getModelName(),
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
      const text = await materialService.readMaterial(materialId, materialText);

      const result = await groqService.dialogueStart({ materialText: text });

      // Track token usage for registered users
      const tokenUsage = groqService.getLastTokenUsage();
      if (tokenUsage) {
        await updateTokenUsageAfterRequest(c, tokenUsage.total_tokens, {
          model: groqService.getModelName(),
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

      const text = await materialService.readMaterial(materialId, materialText);

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

      const result = await groqService.dialogueStep({
        materialText: text,
        topics,
        currentTopicIndex: Number(currentTopicIndex || 0),
        userMessage,
        lastCoachQuestion,
        language,
      });

      // Track token usage for registered users
      const tokenUsage = groqService.getLastTokenUsage();
      if (tokenUsage) {
        await updateTokenUsageAfterRequest(c, tokenUsage.total_tokens, {
          model: groqService.getModelName(),
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

      const text = await materialService.readMaterial(materialId, materialText);

      const result = await groqService.dialogueHint({
        materialText: text,
        currentTopicTitle,
        language,
      });

      // Track token usage for registered users
      const tokenUsage = groqService.getLastTokenUsage();
      if (tokenUsage) {
        await updateTokenUsageAfterRequest(c, tokenUsage.total_tokens, {
          model: groqService.getModelName(),
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

      const text = await materialService.readMaterial(materialId, materialText);

      const result = await groqService.dialogueFeedback({
        materialText: text,
        topics,
        history,
        language,
      });

      // Track token usage for registered users
      const tokenUsage = groqService.getLastTokenUsage();
      if (tokenUsage) {
        await updateTokenUsageAfterRequest(c, tokenUsage.total_tokens, {
          model: groqService.getModelName(),
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
