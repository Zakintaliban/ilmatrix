import type { Context } from "hono";
import { groqService } from "../services/groqService.js";
import { mcqScoringService } from "../services/mcqScoringService.js";
import { materialService } from "../services/materialService.js";

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
        numQuestions: Math.min(Math.max(1, numQuestions), 20), // Limit 1-20 questions
      });

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

      return c.json({ cards });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 500);
    }
  }

  // Placeholder methods for dialogue features
  async startDialogue(c: Context) {
    return c.json(
      { error: "Dialogue feature not implemented in refactor yet" },
      501
    );
  }

  async stepDialogue(c: Context) {
    return c.json(
      { error: "Dialogue feature not implemented in refactor yet" },
      501
    );
  }

  async hintDialogue(c: Context) {
    return c.json(
      { error: "Dialogue feature not implemented in refactor yet" },
      501
    );
  }

  async feedbackDialogue(c: Context) {
    return c.json(
      { error: "Dialogue feature not implemented in refactor yet" },
      501
    );
  }
}

export const aiController = new AIController();
