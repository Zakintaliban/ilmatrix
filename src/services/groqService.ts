import Groq from "groq-sdk";
import { createLimiter, withTimeout } from "../utils/concurrency.js";
import config from "../config/env.js";

/**
 * Circuit breaker to protect against API overuse
 */
class GroqCircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  
  private readonly failureThreshold = 5;
  private readonly recoveryTimeout = 60000; // 1 minute
  private readonly retryTimeout = 10000; // 10 seconds
  
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.recoveryTimeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open. Groq API temporarily unavailable due to rate limiting.');
      }
    }
    
    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }
  
  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      console.log(`[CIRCUIT BREAKER] Opened due to ${this.failures} consecutive failures`);
    }
  }
  
  getStatus(): { state: string; failures: number; nextRetry?: number } {
    return {
      state: this.state,
      failures: this.failures,
      nextRetry: this.state === 'open' ? this.lastFailureTime + this.recoveryTimeout : undefined
    };
  }
}

const circuitBreaker = new GroqCircuitBreaker();

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

export interface DialogueStepResult {
  coachMessage: string;
  addressed: boolean;
  moveToNext: boolean;
  nextCoachQuestion?: string;
}

export interface DialogueFeedbackResult {
  feedback: string;
  strengths: string[];
  improvements: string[];
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * Service for interacting with Groq AI models
 */
export class GroqService {
  private client: Groq;
  private limiter = createLimiter(config.groqConcurrency);
  private lastTokenUsage: TokenUsage | null = null; // Track last request's token usage
  private readonly systemPrompt = `You are Ilmatrix, a study assistant for university students, especially those who prefer studying quietly.

Core rules:
- Use the provided materials as the primary source. Quote short snippets (<= 120 characters) where relevant.
- Be concise, structured, and actionable.
- For quizzes/exams, guide learning first. Provide final answers only when explicitly requested and with brief justification; do NOT reveal chain-of-thought.
- Do not impersonate students or claim access to private systems. Encourage academic integrity.
- When uncertain, say so and suggest what information is missing.
- Output must be safe and respectful.`;

  constructor() {
    this.client = new Groq({
      apiKey: config.groqApiKey || "",
    });
  }

  /**
   * Check if API key is available
   */
  get hasApiKey(): boolean {
    return !!config.groqApiKey;
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
   * Extract embedded images from material text
   * Returns array of {type: "text"|"image_url", ...}
   */
  private extractImagesFromMaterial(materialText: string): any[] {
    const content: any[] = [];
    
    // More precise regex that stops at end of base64, before any additional text
    const imageMatches = materialText.matchAll(
      /\[IMAGE:\s*([^\]]+?)\s*\][\s\S]*?Base64 Data:\s*(data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+?)(?=\n\n|\n[A-Z]|\nVision|\n$|$)/gm
    );

    let lastIndex = 0;
    const images: Array<{ start: number; end: number; data: string; name: string }> = [];

    for (const match of imageMatches) {
      if (match.index !== undefined) {
        // Clean up base64 string (remove any newlines/spaces/tabs)
        let cleanBase64 = match[2].trim();
        
        // Remove all whitespace characters but preserve the data URI format
        if (cleanBase64.startsWith('data:image/')) {
          const [header, base64Part] = cleanBase64.split(',');
          if (base64Part) {
            // Clean only the base64 part, keep the header intact
            const cleanedBase64Part = base64Part.replace(/[\s\r\n\t]+/g, '');
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

      // Add image
      content.push({
        type: "image_url",
        image_url: { url: img.data },
      });

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

  /**
   * Make a chat completion request with timeout and rate limiting
   */
  private async makeRequest(params: any): Promise<string> {
    if (!this.hasApiKey) {
      throw new Error(
        "GROQ_API_KEY is not configured. AI features are unavailable."
      );
    }

    return this.limiter(async () => {
      // Check if any message contains images
      const hasImages = params.messages?.some((msg: any) => {
        if (Array.isArray(msg.content)) {
          return msg.content.some((c: any) => c.type === "image_url");
        }
        return false;
      });

      // Use vision model if images are present
      const model = hasImages 
        ? "meta-llama/llama-4-maverick-17b-128e-instruct" 
        : config.groqModel;

      return withTimeout(
        () =>
          circuitBreaker.execute(async () => {
            const completion = await this.client.chat.completions.create({
              model,
              messages: params.messages,
              temperature: params.temperature || 0.3,
              max_tokens: params.max_tokens || 1500,
            });

            // Track token usage
            if (completion.usage) {
              this.lastTokenUsage = {
                prompt_tokens: completion.usage.prompt_tokens || 0,
                completion_tokens: completion.usage.completion_tokens || 0,
                total_tokens: completion.usage.total_tokens || 0,
              };

              console.log(`[GROQ] Tokens used: ${this.lastTokenUsage.total_tokens} (prompt: ${this.lastTokenUsage.prompt_tokens}, completion: ${this.lastTokenUsage.completion_tokens})`);
            } else {
              // Fallback if no usage info
              this.lastTokenUsage = null;
            }

            return completion;
          }),
        config.groqTimeoutMs,
        "Groq API request timed out"
      ).then((completion) => {
        return completion.choices?.[0]?.message?.content || "";
      });
    });
  }

  /**
   * Get token usage from the last API request
   * Returns null if no request has been made yet or if usage info wasn't available
   */
  getLastTokenUsage(): TokenUsage | null {
    return this.lastTokenUsage;
  }

  /**
   * Clear token usage tracking
   */
  clearTokenUsage(): void {
    this.lastTokenUsage = null;
  }

  /**
   * Get the current model name being used
   */
  getModelName(): string {
    return config.groqModel;
  }

  /**
   * Extract JSON block from AI response
   */
  private extractJsonBlock(text: string): any {
    try {
      // Try to find JSON in code blocks first (array or object)
      const jsonBlockMatch = text.match(
        /```(?:json)?\s*([{\[][\s\S]*?[}\]])\s*```/
      );
      if (jsonBlockMatch) {
        return JSON.parse(jsonBlockMatch[1]);
      }

      // Try to find JSON array first (since quiz responses are arrays)
      const arrayMatch = text.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        return JSON.parse(arrayMatch[0]);
      }

      // Try to find any JSON object
      const objectMatch = text.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        return JSON.parse(objectMatch[0]);
      }

      return null;
    } catch {
      return null;
    }
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
${this.clampText(params.materialText)}
---
`;

    try {
      return await this.makeRequest({
        messages: [
          { role: "system", content: this.systemPrompt },
          { role: "user", content },
        ],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `I encountered an error while processing your request: ${message}`;
    }
  }

  /**
   * Generate chat response with multimodal support
   */
  async generateChat(params: {
    materialText: string;
    messages: ChatMessage[];
  }): Promise<string> {
    try {
      // Extract images from material if present
      const materialContent = this.extractImagesFromMaterial(params.materialText);
      
      // Build messages with multimodal support
      // System message must be plain text only
      const systemMessage = this.systemPrompt + (params.materialText ? "\n\nContext materials will be provided in the next message." : "");
      
      // Build messages array
      const messages: any[] = [
        { role: "system", content: systemMessage }
      ];
      
      // If we have material content, add it as a separate user message before the actual user messages
      if (params.materialText && materialContent.length > 0) {
        if (materialContent.some((c: any) => c.type === "image_url")) {
          // Multimodal material - add as user message with images
          messages.push({
            role: "user", 
            content: [
              { type: "text", text: "Context materials:" },
              ...materialContent
            ]
          });
        } else {
          // Text-only material - add as user message with text
          messages.push({
            role: "user",
            content: `Context materials:\n---\n${this.clampText(params.materialText)}\n---`
          });
        }
      }
      
      // Add actual user messages
      messages.push(...params.messages);

      return await this.makeRequest({ messages });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `I encountered an error while processing your chat: ${message}`;
    }
  }

  /**
   * Generate MCQ questions with embedded answers
   */
  async generateQuizTrainerMCQ(params: {
    materialText: string;
    numQuestions: number;
  }): Promise<QuizQuestion[]> {
    const prompt = `
Generate ${params.numQuestions} multiple-choice questions based on the provided materials. Output as JSON array only:

[
  {
    "id": 1,
    "question": "...",
    "options": ["A", "B", "C", "D", "E"],
    "answer": "B",
    "rationale": "brief explanation of why this answer is correct",
    "weaknesses": ["common misconception 1", "common error 2"],
    "studyPlan": ["suggestion 1", "suggestion 2"]
  }
]

Rules:
- Questions should test understanding, not just memorization
- Each question must have exactly 5 options (A-E)
- Provide clear rationale for correct answers
- Include 2-3 common weaknesses students might have
- Suggest 2-3 study plan items for improvement
- Base everything on the provided materials
`;

    const content = `${prompt}\n\nMATERIALS:\n---\n${this.clampText(
      params.materialText
    )}\n---`;

    try {
      const response = await this.makeRequest({
        messages: [
          {
            role: "system",
            content:
              "You are an expert educator creating assessment materials. Respond only with valid JSON.",
          },
          { role: "user", content },
        ],
        temperature: 0.2,
        max_tokens: 8000, // Increased for larger question sets (up to 50 questions)
      });

      const questions = this.extractJsonBlock(response);
      if (!Array.isArray(questions)) {
        throw new Error("Invalid response format");
      }

      return questions.map((q, index) => ({
        id: q.id || index + 1,
        question: String(q.question || ""),
        options: Array.isArray(q.options) ? q.options.slice(0, 5) : [],
        answer: String(q.answer || "A"),
        rationale: String(q.rationale || ""),
        weaknesses: Array.isArray(q.weaknesses) ? q.weaknesses : [],
        studyPlan: Array.isArray(q.studyPlan) ? q.studyPlan : [],
      }));
    } catch (error) {
      throw new Error(
        `Failed to generate quiz questions: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Generate flashcards
   */
  async generateFlashcards(params: {
    materialText: string;
    numCards: number;
  }): Promise<FlashCard[]> {
    const prompt = `
Create ${params.numCards} flashcards from the provided materials. Output as JSON array only:

[
  {
    "id": 1,
    "front": "Question or concept",
    "back": "Answer or explanation"
  }
]

Rules:
- Cards should cover key concepts and important facts
- Front side: clear, concise questions or prompts
- Back side: accurate, complete answers
- Based strictly on provided materials
`;

    const content = `${prompt}\n\nMATERIALS:\n---\n${this.clampText(
      params.materialText
    )}\n---`;

    try {
      const response = await this.makeRequest({
        messages: [
          {
            role: "system",
            content:
              "Create educational flashcards. Respond only with valid JSON.",
          },
          { role: "user", content },
        ],
        temperature: 0.2,
        max_tokens: 1500,
      });

      const cards = this.extractJsonBlock(response);
      if (!Array.isArray(cards)) {
        throw new Error("Invalid response format");
      }

      return cards.map((card, index) => ({
        id: card.id || index + 1,
        front: String(card.front || ""),
        back: String(card.back || ""),
      }));
    } catch (error) {
      throw new Error(
        `Failed to generate flashcards: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // Dialogue methods would be implemented here with similar patterns...
  // For brevity, I'll add placeholders

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
    const material = this.clampText(materialText);
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
      const response = await this.makeRequest({
        messages: [
          {
            role: "system",
            content: this.systemPrompt,
          },
          { role: "user", content },
        ],
        temperature: 0.4,
        max_tokens: 1500,
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
      throw new Error(
        `Failed to start dialogue: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
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

    const material = this.clampText(materialText);
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
        const response = await this.makeRequest({
          messages: [
            {
              role: "system",
              content: this.systemPrompt,
            },
            { role: "user", content },
          ],
          temperature: 0.5,
          max_tokens: 1500,
        });

        const result = this.extractJsonBlock(response);
        if (!result) {
          throw new Error("Invalid response format");
        }

        return {
          addressed: Boolean(result.addressed),
          moveToNext: false, // Never move to next on last topic
          isComplete: Boolean(result.isComplete),
          coachMessage: String(result.coachMessage || ""),
          nextCoachQuestion: result.isComplete
            ? undefined
            : String(result.nextCoachQuestion || ""),
        };
      } catch (error) {
        throw new Error(
          `Failed to process final dialogue step: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
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
      const response = await this.makeRequest({
        messages: [
          {
            role: "system",
            content: this.systemPrompt,
          },
          { role: "user", content },
        ],
        temperature: 0.5,
        max_tokens: 1500,
      });

      const result = this.extractJsonBlock(response);
      if (!result) {
        throw new Error("Invalid response format");
      }

      return {
        addressed: Boolean(result.addressed),
        moveToNext: Boolean(result.moveToNext && !isLastTopic),
        coachMessage: String(result.coachMessage || ""),
        nextCoachQuestion: result.nextCoachQuestion
          ? String(result.nextCoachQuestion)
          : undefined,
      };
    } catch (error) {
      throw new Error(
        `Failed to process dialogue step: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
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
    const material = this.clampText(materialText);

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
      const response = await this.makeRequest({
        messages: [
          {
            role: "system",
            content: this.systemPrompt,
          },
          { role: "user", content },
        ],
        temperature: 0.6,
        max_tokens: 500,
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
      throw new Error(
        `Failed to generate hint: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
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
    const material = this.clampText(materialText);

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
      const response = await this.makeRequest({
        messages: [
          {
            role: "system",
            content: this.systemPrompt,
          },
          { role: "user", content },
        ],
        temperature: 0.4,
        max_tokens: 1500,
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
      throw new Error(
        `Failed to generate feedback: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

// Export singleton instance
export const groqService = new GroqService();
