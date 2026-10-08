import config from "../config/env.js";
import {
  AIServiceError,
  GroqProvider,
  trackUsage,
  type ChatClient,
  type CompletionRequest,
  type ProviderConfig,
  type TokenUsage,
} from "./groqProvider.js";

export type { TokenUsage } from "./groqProvider.js";
export { AIServiceError } from "./groqProvider.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface QuizQuestion {
  id: number;
  question: string;
  options: string[];
  answer: string;
  rationale?: string;
  weaknesses?: string[];
  studyPlan?: string[];
}

export interface FlashCard {
  id: number;
  front: string;
  back: string;
}

export interface DialogueTopic {
  id: number;
  title: string;
}

export interface DialogueStartResult {
  language: string; // e.g., "id" or "en"
  intro: string; // opener text to show after Start
  topics: DialogueTopic[]; // exactly 3 topics
  firstCoachPrompt: string; // first coach question to begin topic 1
}

export interface DialogueStepResult {
  addressed: boolean; // did user's answer sufficiently address current topic?
  moveToNext: boolean; // if true and there is a next topic, UI should advance
  coachMessage: string; // coach reply to show
  nextCoachQuestion?: string; // if moving to next topic, the first question for that topic
  isComplete?: boolean; // if true, the dialogue session is finished
}

export interface DialogueHintResult {
  hint: string;
}

export interface DialogueFeedbackResult {
  feedback: string; // final feedback paragraph(s)
  strengths: string[];
  improvements: string[];
}

export interface DialogueSession {
  sessionId: string;
  language: string;
  intro: string;
  topics: Array<{ id: number; title: string }>;
  firstCoachPrompt: string;
}

/** Groq accepts at most this many images per vision request. */
const MAX_IMAGES_PER_REQUEST = 3;

/** Matches the image blocks extractionService stores for images without text. */
const IMAGE_BLOCK_RE =
  /\[IMAGE:\s*([^\]]+?)\s*\][\s\S]*?Base64 Data:\s*(data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+?)(?=\n\n|\n[A-Z]|\nVision|\n$|$)/gm;

const LETTERS = ["A", "B", "C", "D", "E"];

// ---------------------------------------------------------------------------
// JSON schemas for structured outputs (strict mode: every property required,
// additionalProperties false, object at the root)
// ---------------------------------------------------------------------------

const stringArray = { type: "array", items: { type: "string" } };

const MCQ_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          question: { type: "string" },
          options: stringArray,
          answer: { type: "string", enum: LETTERS },
          rationale: { type: "string" },
          weaknesses: stringArray,
          studyPlan: stringArray,
        },
        required: ["id", "question", "options", "answer", "rationale", "weaknesses", "studyPlan"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

const FLASHCARDS_SCHEMA = {
  type: "object",
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          front: { type: "string" },
          back: { type: "string" },
        },
        required: ["id", "front", "back"],
        additionalProperties: false,
      },
    },
  },
  required: ["cards"],
  additionalProperties: false,
};

const DIALOGUE_START_SCHEMA = {
  type: "object",
  properties: {
    language: { type: "string", enum: ["id", "en"] },
    intro: { type: "string" },
    topics: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, title: { type: "string" } },
        required: ["id", "title"],
        additionalProperties: false,
      },
    },
    firstCoachPrompt: { type: "string" },
  },
  required: ["language", "intro", "topics", "firstCoachPrompt"],
  additionalProperties: false,
};

const DIALOGUE_STEP_SCHEMA = {
  type: "object",
  properties: {
    addressed: { type: "boolean" },
    moveToNext: { type: "boolean" },
    coachMessage: { type: "string" },
    nextCoachQuestion: { type: ["string", "null"] },
  },
  required: ["addressed", "moveToNext", "coachMessage", "nextCoachQuestion"],
  additionalProperties: false,
};

const DIALOGUE_FINAL_STEP_SCHEMA = {
  type: "object",
  properties: {
    addressed: { type: "boolean" },
    isComplete: { type: "boolean" },
    coachMessage: { type: "string" },
    nextCoachQuestion: { type: ["string", "null"] },
  },
  required: ["addressed", "isComplete", "coachMessage", "nextCoachQuestion"],
  additionalProperties: false,
};

const DIALOGUE_HINT_SCHEMA = {
  type: "object",
  properties: { hint: { type: "string" } },
  required: ["hint"],
  additionalProperties: false,
};

const DIALOGUE_FEEDBACK_SCHEMA = {
  type: "object",
  properties: {
    feedback: { type: "string" },
    strengths: stringArray,
    improvements: stringArray,
  },
  required: ["feedback", "strengths", "improvements"],
  additionalProperties: false,
};

/**
 * Service for interacting with Groq AI models
 */
export class GroqService {
  private provider: GroqProvider;
  private readonly systemPrompt = `You are Ilmatrix, a study assistant for university students, especially those who prefer studying quietly.

Core rules:
- Use the provided materials as the primary source. Quote short snippets (<= 120 characters) where relevant.
- Be concise, structured, and actionable.
- For quizzes/exams, guide learning first. Provide final answers only when explicitly requested and with brief justification; do NOT reveal chain-of-thought.
- Do not impersonate students or claim access to private systems. Encourage academic integrity.
- When uncertain, say so and suggest what information is missing.
- Output must be safe and respectful.
- Reply in the same language as the student's latest message; if unclear, use Bahasa Indonesia.
- Format with Markdown. Do not use LaTeX; write math in plain text or Unicode (e.g., x², √x, ∫, ≤).`;

  constructor(opts: { client?: ChatClient; config?: Partial<ProviderConfig> } = {}) {
    this.provider = new GroqProvider(opts);
  }

  /**
   * Check if API key is available
   */
  get hasApiKey(): boolean {
    return this.provider.isConfigured;
  }

  /**
   * Run a study-tool call and return its result together with the token usage
   * of exactly that call (safe under concurrent requests).
   */
  track<T>(fn: () => Promise<T>) {
    return trackUsage(fn);
  }

  /**
   * Get the primary model name being used
   */
  getModelName(): string {
    return this.provider.cfg.model;
  }

  /**
   * Clamp text to prevent token limit issues
   */
  private clampText(text: string, maxLength = config.materialClamp): string {
    if (text.length <= maxLength) return text;

    const half = Math.floor(maxLength / 2);
    const start = text.slice(0, half);
    const end = text.slice(-half);

    return `${start}\n\n[... content truncated ...]\n\n${end}`;
  }

  /**
   * Replace embedded base64 images with short placeholders so text-only
   * models never receive (and bill) raw image data.
   */
  private stripImageData(materialText: string): string {
    return materialText.replace(
      IMAGE_BLOCK_RE,
      (_m, name: string) => `[IMAGE: ${String(name).trim()} — visual content not included in this request]`
    );
  }

  /**
   * Extract embedded images from material text
   * Returns array of {type: "text"|"image_url", ...}
   */
  private extractImagesFromMaterial(materialText: string): any[] {
    const content: any[] = [];

    let lastIndex = 0;
    const images: Array<{ start: number; end: number; data: string; name: string }> = [];

    for (const match of materialText.matchAll(IMAGE_BLOCK_RE)) {
      if (match.index !== undefined) {
        // Clean up base64 string (remove any newlines/spaces/tabs)
        let cleanBase64 = match[2].trim();

        // Remove all whitespace characters but preserve the data URI format
        if (cleanBase64.startsWith("data:image/")) {
          const [header, base64Part] = cleanBase64.split(",");
          if (base64Part) {
            // Clean only the base64 part, keep the header intact
            const cleanedBase64Part = base64Part.replace(/[\s\r\n\t]+/g, "");
            cleanBase64 = `${header},${cleanedBase64Part}`;
          }
        }

        images.push({
          start: match.index,
          end: match.index + match[0].length,
          data: cleanBase64,
          name: match[1].trim(),
        });
      }
    }

    // If no images, return text only
    if (images.length === 0) {
      return [{ type: "text", text: this.clampText(materialText) }];
    }

    // Build content array with text and images interleaved
    for (let i = 0; i < images.length; i++) {
      const img = images[i];

      // Add text before this image
      if (img.start > lastIndex) {
        const textSegment = materialText.slice(lastIndex, img.start).trim();
        if (textSegment && textSegment !== "===== FILE: " + img.name + " =====") {
          content.push({ type: "text", text: textSegment });
        }
      }

      // Groq caps images per request; describe the rest instead of sending them
      if (i < MAX_IMAGES_PER_REQUEST) {
        content.push({
          type: "image_url",
          image_url: { url: img.data },
        });
      } else {
        content.push({
          type: "text",
          text: `[IMAGE: ${img.name} — not analyzed: at most ${MAX_IMAGES_PER_REQUEST} images per request]`,
        });
      }

      lastIndex = img.end;
    }

    // Add remaining text after last image
    if (lastIndex < materialText.length) {
      const textSegment = materialText.slice(lastIndex).trim();
      if (textSegment) {
        content.push({ type: "text", text: this.clampText(textSegment) });
      }
    }

    return content;
  }

  private async complete(req: CompletionRequest): Promise<string> {
    const result = await this.provider.complete(req);
    return result.content;
  }

  /**
   * Parse a JSON response. Structured outputs return pure JSON; the regex
   * fallbacks cover the prompt-only path.
   */
  private extractJsonBlock(text: string): any {
    const trimmed = (text || "").trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to lenient extraction
    }
    try {
      // Try to find JSON in code blocks first (array or object)
      const jsonBlockMatch = trimmed.match(
        /```(?:json)?\s*([{\[][\s\S]*?[}\]])\s*```/
      );
      if (jsonBlockMatch) {
        return JSON.parse(jsonBlockMatch[1]);
      }

      // Prefer a top-level object, then an array
      const objectMatch = trimmed.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        return JSON.parse(objectMatch[0]);
      }

      const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        return JSON.parse(arrayMatch[0]);
      }

      return null;
    } catch {
      return null;
    }
  }

  /** Accept both `{ <key>: [...] }` and a bare array. */
  private extractList(parsed: any, key: string): any[] | null {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed[key])) return parsed[key];
    return null;
  }

  private errorMessage(error: unknown): string {
    if (error instanceof AIServiceError) return error.userMessage;
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Generate answer for general questions
   */
  async generateAnswer(params: {
    materialText: string;
    task: "explain" | "quiz" | "forum" | "exam";
    prompt?: string;
  }): Promise<string> {
    const content = `
TASK: ${params.task.toUpperCase()}
${params.prompt ? `PROMPT: ${params.prompt}` : ""}

MATERIALS:
---
${this.clampText(this.stripImageData(params.materialText))}
---
`;

    try {
      return await this.complete({
        messages: [
          { role: "system", content: this.systemPrompt },
          { role: "user", content },
        ],
        maxOutputTokens: 2500,
      });
    } catch (error) {
      console.error(`[AI] ${params.task} failed:`, error);
      return `I encountered an error while processing your request: ${this.errorMessage(error)}`;
    }
  }

  /**
   * Generate chat response with multimodal support
   */
  async generateChat(params: {
    materialText: string;
    messages: ChatMessage[];
  }): Promise<string> {
    // Build messages with multimodal support
    // System message must be plain text only
    const systemMessage = this.systemPrompt + (params.materialText ? "\n\nContext materials will be provided in the next message." : "");

    const buildMessages = (materialMessage: any | null): any[] => {
      const messages: any[] = [{ role: "system", content: systemMessage }];
      if (materialMessage) messages.push(materialMessage);
      messages.push(...params.messages);
      return messages;
    };

    const textOnlyMaterial = params.materialText
      ? {
          role: "user",
          content: `Context materials:\n---\n${this.clampText(this.stripImageData(params.materialText))}\n---`,
        }
      : null;

    try {
      // Extract images from material if present
      const materialContent = params.materialText
        ? this.extractImagesFromMaterial(params.materialText)
        : [];
      const hasImages = materialContent.some((c: any) => c.type === "image_url");

      if (hasImages && this.provider.hasVision) {
        try {
          return await this.complete({
            messages: buildMessages({
              role: "user",
              content: [{ type: "text", text: "Context materials:" }, ...materialContent],
            }),
            maxOutputTokens: 2500,
            reasoningEffort: "low",
            vision: true,
          });
        } catch (error) {
          if (!(error instanceof AIServiceError) || error.code !== "vision_unavailable") {
            throw error;
          }
          console.warn("[AI] Vision model unavailable; answering from text only");
        }
      }

      const note = hasImages
        ? "\n\n(Note: the attached images could not be analyzed right now; answer from the text and tell the student the images were not viewed.)"
        : "";
      const messages = buildMessages(textOnlyMaterial);
      if (note) messages[0] = { role: "system", content: systemMessage + note };

      return await this.complete({ messages, maxOutputTokens: 2500 });
    } catch (error) {
      console.error("[AI] chat failed:", error);
      return `I encountered an error while processing your chat: ${this.errorMessage(error)}`;
    }
  }

  /**
   * Extract text from an image (OCR) with the vision model.
   * Returns "" when vision is unavailable so callers can keep the raw image.
   */
  async extractTextFromImage(dataUrl: string): Promise<string> {
    if (!this.provider.hasVision) return "";
    const text = await this.complete({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract ALL text from this image. Return ONLY the extracted text with proper formatting and line breaks. Do not add any explanations, descriptions, or additional commentary. If the image contains tables, preserve the table structure using markdown format. If there is no text, return an empty response.",
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0.1, // Low temperature for accurate OCR
      maxOutputTokens: 4000, // Enough for most document text
      reasoningEffort: "none",
      vision: true,
    });
    return text.trim();
  }

  /**
   * Generate MCQ questions with embedded answers
   */
  async generateQuizTrainerMCQ(params: {
    materialText: string;
    numQuestions: number;
  }): Promise<QuizQuestion[]> {
    const prompt = `
Generate ${params.numQuestions} multiple-choice questions based on the provided materials. Output JSON only, as an object:

{
  "questions": [
    {
      "id": 1,
      "question": "...",
      "options": ["first option text", "second option text", "third option text", "fourth option text", "fifth option text"],
      "answer": "B",
      "rationale": "brief explanation of why this answer is correct",
      "weaknesses": ["common misconception 1", "common error 2"],
      "studyPlan": ["suggestion 1", "suggestion 2"]
    }
  ]
}

Rules:
- Questions should test understanding, not just memorization
- Each question must have exactly 5 options; write only the option text (no "A." prefixes)
- "answer" is the letter (A-E) of the correct option
- Provide clear rationale for correct answers
- Include 2-3 common weaknesses students might have
- Suggest 2-3 study plan items for improvement
- Base everything on the provided materials
- Write in the same language as the materials
`;

    const content = `${prompt}\n\nMATERIALS:\n---\n${this.clampText(
      this.stripImageData(params.materialText)
    )}\n---`;

    try {
      const response = await this.complete({
        messages: [
          {
            role: "system",
            content:
              "You are an expert educator creating assessment materials. Respond only with valid JSON.",
          },
          { role: "user", content },
        ],
        temperature: 0.2,
        // ~260 tokens per question (rationale, weaknesses, study plan)
        maxOutputTokens: Math.min(16000, 600 + params.numQuestions * 260),
        reasoningEffort: "low",
        json: { name: "mcq_questions", schema: MCQ_SCHEMA },
      });

      const questions = this.extractList(this.extractJsonBlock(response), "questions");
      if (!questions) {
        throw new Error("Invalid response format");
      }

      return questions.map((q, index) => ({
        // Number sequentially: the UI and "1 a, 2 b" answers rely on 1..n
        id: index + 1,
        question: String(q.question || ""),
        options: Array.isArray(q.options)
          ? q.options.slice(0, 5).map((o: unknown) => String(o).replace(/^\s*[A-Ea-e][.)]\s+/, ""))
          : [],
        answer: this.normalizeAnswerLetter(q.answer),
        rationale: String(q.rationale || ""),
        weaknesses: Array.isArray(q.weaknesses) ? q.weaknesses.map(String) : [],
        studyPlan: Array.isArray(q.studyPlan) ? q.studyPlan.map(String) : [],
      }));
    } catch (error) {
      throw new Error(`Failed to generate quiz questions: ${this.errorMessage(error)}`);
    }
  }

  /** JSON booleans may arrive as strings on the prompt-only fallback path. */
  private toBool(value: unknown): boolean {
    return value === true || (typeof value === "string" && /^\s*true\s*$/i.test(value));
  }

  private normalizeAnswerLetter(answer: unknown): string {
    const match = String(answer || "").trim().match(/^[(\[]?([A-Ea-e])\b/);
    return match ? match[1].toUpperCase() : "A";
  }

  /**
   * Generate flashcards
   */
  async generateFlashcards(params: {
    materialText: string;
    numCards: number;
  }): Promise<FlashCard[]> {
    const prompt = `
Create ${params.numCards} flashcards from the provided materials. Output JSON only, as an object:

{
  "cards": [
    {
      "id": 1,
      "front": "Question or concept",
      "back": "Answer or explanation"
    }
  ]
}

Rules:
- Cards should cover key concepts and important facts
- Front side: clear, concise questions or prompts
- Back side: accurate, complete answers
- Based strictly on provided materials
- Write in the same language as the materials
`;

    const content = `${prompt}\n\nMATERIALS:\n---\n${this.clampText(
      this.stripImageData(params.materialText)
    )}\n---`;

    try {
      const response = await this.complete({
        messages: [
          {
            role: "system",
            content:
              "Create educational flashcards. Respond only with valid JSON.",
          },
          { role: "user", content },
        ],
        temperature: 0.2,
        maxOutputTokens: Math.min(12000, 300 + params.numCards * 120),
        reasoningEffort: "low",
        json: { name: "flashcards", schema: FLASHCARDS_SCHEMA },
      });

      const cards = this.extractList(this.extractJsonBlock(response), "cards");
      if (!cards) {
        throw new Error("Invalid response format");
      }

      return cards.map((card, index) => ({
        id: index + 1,
        front: String(card.front || ""),
        back: String(card.back || ""),
      }));
    } catch (error) {
      throw new Error(`Failed to generate flashcards: ${this.errorMessage(error)}`);
    }
  }

  /**
   * Detect language from text for dialogue
   */
  private detectLangFromText(text: string): "id" | "en" | "auto" {
    // Light heuristic for language detection
    const sample = (text || "").slice(0, 400).toLowerCase();
    const hasIndo =
      /\b(yang|dan|atau|dengan|adalah|tidak|untuk|dari|pada|dalam|itu|ini)\b/.test(
        sample
      );
    return hasIndo ? "id" : "auto";
  }

  /**
   * Start a dialogue session
   */
  async dialogueStart(params: {
    materialText: string;
  }): Promise<DialogueStartResult> {
    if (!this.hasApiKey) {
      throw new Error("GROQ_API_KEY required for dialogue features");
    }

    const { materialText } = params;
    const material = this.clampText(this.stripImageData(materialText));
    const langHint = this.detectLangFromText(materialText);

    const content = `Based on this material, create a dialogue session with exactly 3 topics for discussion.

Material:
${material}

Language preference: ${
      langHint === "id"
        ? "Bahasa Indonesia"
        : "English or auto-detect from material"
    }

Create a dialogue session with:
1. A welcoming introduction
2. Exactly 3 discussion topics derived from the material
3. A first coaching question to begin topic 1

Response format (JSON only):
{
  "language": "${langHint === "id" ? "id" : "en"}",
  "intro": "Welcoming introduction text explaining the dialogue format",
  "topics": [
    {"id": 1, "title": "First topic title"},
    {"id": 2, "title": "Second topic title"},
    {"id": 3, "title": "Third topic title"}
  ],
  "firstCoachPrompt": "Opening question for topic 1"
}

Important: Return ONLY the JSON object, no extra text.`;

    try {
      const response = await this.complete({
        messages: [
          {
            role: "system",
            content: this.systemPrompt,
          },
          { role: "user", content },
        ],
        temperature: 0.4,
        maxOutputTokens: 1500,
        reasoningEffort: "low",
        json: { name: "dialogue_start", schema: DIALOGUE_START_SCHEMA },
      });

      const result = this.extractJsonBlock(response);
      if (!result || !result.topics || !Array.isArray(result.topics)) {
        throw new Error("Invalid response format");
      }

      return {
        language: String(result.language || "en"),
        intro: String(result.intro || ""),
        topics: result.topics.slice(0, 3).map((t: any, i: number) => ({
          id: t.id || i + 1,
          title: String(t.title || `Topic ${i + 1}`),
        })),
        firstCoachPrompt: String(result.firstCoachPrompt || ""),
      };
    } catch (error) {
      throw new Error(`Failed to start dialogue: ${this.errorMessage(error)}`);
    }
  }

  /**
   * Process a dialogue step
   */
  async dialogueStep(params: {
    materialText: string;
    topics: DialogueTopic[];
    currentTopicIndex: number;
    userMessage: string;
    lastCoachQuestion?: string;
    language?: "id" | "en";
  }): Promise<DialogueStepResult> {
    if (!this.hasApiKey) {
      throw new Error("GROQ_API_KEY required for dialogue features");
    }

    const {
      materialText,
      topics,
      currentTopicIndex,
      userMessage,
      lastCoachQuestion,
      language = "en",
    } = params;

    const material = this.clampText(this.stripImageData(materialText));
    const currentTopic = topics[currentTopicIndex];
    const isLastTopic = currentTopicIndex >= topics.length - 1;

    // If it's the last topic, we need to determine if the dialogue should end
    if (isLastTopic) {
      const content = `You are a dialogue coach helping a student discuss material. Evaluate if the student has adequately completed the final topic.

Material:
${material}

Final Topic: ${currentTopic?.title || "Unknown"}
Last Coach Question: ${lastCoachQuestion || "None"}
Student Response: ${userMessage}

Language: ${language === "id" ? "Bahasa Indonesia" : "English"}

Determine if the student's response adequately addresses the final topic. If yes, provide completion congratulations. If no, provide guidance to help them complete it.

Response format (JSON only):
{
  "addressed": "boolean - whether student adequately addressed the final topic",
  "isComplete": "boolean - if true, the dialogue session is finished",
  "coachMessage": "Your response: either completion congratulations or guidance for final topic",
  "nextCoachQuestion": "null if isComplete=true, otherwise a follow-up question for the final topic"
}

Important: Return ONLY the JSON object, no extra text.`;

      try {
        const response = await this.complete({
          messages: [
            {
              role: "system",
              content: this.systemPrompt,
            },
            { role: "user", content },
          ],
          temperature: 0.5,
          maxOutputTokens: 1500,
          reasoningEffort: "low",
          json: { name: "dialogue_final_step", schema: DIALOGUE_FINAL_STEP_SCHEMA },
        });

        const result = this.extractJsonBlock(response);
        if (!result) {
          throw new Error("Invalid response format");
        }

        return {
          addressed: this.toBool(result.addressed),
          moveToNext: false, // Never move to next on last topic
          isComplete: this.toBool(result.isComplete),
          coachMessage: String(result.coachMessage || ""),
          nextCoachQuestion: this.toBool(result.isComplete)
            ? undefined
            : String(result.nextCoachQuestion || ""),
        };
      } catch (error) {
        throw new Error(`Failed to process final dialogue step: ${this.errorMessage(error)}`);
      }
    }

    // For non-final topics, use the original logic
    const content = `You are a dialogue coach helping a student discuss material. Evaluate their response and guide the conversation.

Material:
${material}

Current Topic: ${currentTopic?.title || "Unknown"}
Last Coach Question: ${lastCoachQuestion || "None"}
Student Response: ${userMessage}

Topics remaining: ${topics.map((t, i) => `${i + 1}. ${t.title}`).join(", ")}
Current topic index: ${currentTopicIndex + 1}/${topics.length}

Language: ${language === "id" ? "Bahasa Indonesia" : "English"}

Evaluate if the student's response adequately addresses the current topic. Provide coaching feedback and decide whether to move to the next topic.

Response format (JSON only):
{
  "addressed": "boolean - whether student adequately addressed current topic",
  "moveToNext": "boolean - if true, advance to next topic",
  "coachMessage": "Your coaching response to the student",
  "nextCoachQuestion": "Question for next topic if moveToNext is true, otherwise null"
}

Important: Return ONLY the JSON object, no extra text.`;

    try {
      const response = await this.complete({
        messages: [
          {
            role: "system",
            content: this.systemPrompt,
          },
          { role: "user", content },
        ],
        temperature: 0.5,
        maxOutputTokens: 1500,
        reasoningEffort: "low",
        json: { name: "dialogue_step", schema: DIALOGUE_STEP_SCHEMA },
      });

      const result = this.extractJsonBlock(response);
      if (!result) {
        throw new Error("Invalid response format");
      }

      return {
        addressed: this.toBool(result.addressed),
        moveToNext: this.toBool(result.moveToNext) && !isLastTopic,
        coachMessage: String(result.coachMessage || ""),
        nextCoachQuestion: result.nextCoachQuestion
          ? String(result.nextCoachQuestion)
          : undefined,
      };
    } catch (error) {
      throw new Error(`Failed to process dialogue step: ${this.errorMessage(error)}`);
    }
  }

  /**
   * Provide a hint for current topic
   */
  async dialogueHint(params: {
    materialText: string;
    currentTopicTitle: string;
    language?: "id" | "en";
  }): Promise<DialogueHintResult> {
    if (!this.hasApiKey) {
      throw new Error("GROQ_API_KEY required for dialogue features");
    }

    const { materialText, currentTopicTitle, language = "en" } = params;
    const material = this.clampText(this.stripImageData(materialText));

    const content = `Provide a helpful hint for the current dialogue topic.

Material:
${material}

Current Topic: ${currentTopicTitle}
Language: ${language === "id" ? "Bahasa Indonesia" : "English"}

Give a short, encouraging hint (1-2 sentences) to help the student think about this topic without giving away the full answer.

Response format (JSON only):
{
  "hint": "Brief, encouraging hint text"
}

Important: Return ONLY the JSON object, no extra text.`;

    try {
      const response = await this.complete({
        messages: [
          {
            role: "system",
            content: this.systemPrompt,
          },
          { role: "user", content },
        ],
        temperature: 0.6,
        maxOutputTokens: 500,
        reasoningEffort: "low",
        json: { name: "dialogue_hint", schema: DIALOGUE_HINT_SCHEMA },
      });

      const result = this.extractJsonBlock(response);
      if (!result) {
        throw new Error("Invalid response format");
      }

      return {
        hint: String(
          result.hint || "Try to think about the key concepts in this topic."
        ),
      };
    } catch (error) {
      throw new Error(`Failed to generate hint: ${this.errorMessage(error)}`);
    }
  }

  /**
   * Generate final feedback for dialogue session
   */
  async dialogueFeedback(params: {
    materialText: string;
    topics: DialogueTopic[];
    history?: Array<{
      role: "coach" | "user" | "ilmatrix" | "system";
      content: string;
    }>;
    language?: "id" | "en";
  }): Promise<DialogueFeedbackResult> {
    if (!this.hasApiKey) {
      throw new Error("GROQ_API_KEY required for dialogue features");
    }

    const { materialText, topics, history = [], language = "en" } = params;
    const material = this.clampText(this.stripImageData(materialText));

    const historyText = history
      .map((h) => `${h.role}: ${h.content}`)
      .join("\n");

    const content = `Provide final feedback for this dialogue session.

Material:
${material}

Topics Covered: ${topics.map((t) => t.title).join(", ")}

Conversation History:
${historyText}

Language: ${language === "id" ? "Bahasa Indonesia" : "English"}

Provide constructive feedback about the student's participation, understanding, and areas for improvement.

Response format (JSON only):
{
  "feedback": "Overall feedback paragraph about the session",
  "strengths": ["Strength 1", "Strength 2", "Strength 3"],
  "improvements": ["Improvement area 1", "Improvement area 2", "Improvement area 3"]
}

Important: Return ONLY the JSON object, no extra text.`;

    try {
      const response = await this.complete({
        messages: [
          {
            role: "system",
            content: this.systemPrompt,
          },
          { role: "user", content },
        ],
        temperature: 0.4,
        maxOutputTokens: 1500,
        reasoningEffort: "low",
        json: { name: "dialogue_feedback", schema: DIALOGUE_FEEDBACK_SCHEMA },
      });

      const result = this.extractJsonBlock(response);
      if (!result) {
        throw new Error("Invalid response format");
      }

      return {
        feedback: String(result.feedback || ""),
        strengths: Array.isArray(result.strengths)
          ? result.strengths.slice(0, 3).map(String)
          : [],
        improvements: Array.isArray(result.improvements)
          ? result.improvements.slice(0, 3).map(String)
          : [],
      };
    } catch (error) {
      throw new Error(`Failed to generate feedback: ${this.errorMessage(error)}`);
    }
  }
}

// Export singleton instance
export const groqService = new GroqService();
