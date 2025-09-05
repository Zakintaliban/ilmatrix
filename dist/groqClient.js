import "dotenv/config";
import Groq from "groq-sdk";
const MODEL =
  process.env.GROQ_MODEL || "meta-llama/llama-4-maverick-17b-128e-instruct";
const systemPrompt = `You are StudyAI, a study assistant for university students, especially those who prefer studying quietly.
Core rules:
- Use the provided materials as the primary source. Quote short snippets (<= 120 characters) where relevant.
- Be concise, structured, and actionable.
- For quizzes/exams, guide learning first. Provide final answers only when explicitly requested and with brief justification; do NOT reveal chain-of-thought.
- Do not impersonate students or claim access to private systems. Encourage academic integrity.
- When uncertain, say so and suggest what information is missing.
- Output must be safe and respectful.`;
function clamp(text, max = 12000) {
  return text.length <= max ? text : text.slice(0, max);
}
export async function generateAnswer(params) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return "Server is missing GROQ_API_KEY. Set it in .env and restart.";
  }
  const groq = new Groq({ apiKey });
  const { task, materialText, userInput } = params;
  const taskInstruction =
    task === "explain"
      ? "Explain the material clearly with a short summary, key points, and examples."
      : task === "quiz"
      ? "Assist with a quiz. If questions are provided, answer them with brief justifications and citations. If not, generate N plausible quiz questions with answers from the material. Do not reveal chain-of-thought; provide final answers with brief justification only."
      : task === "forum"
      ? "Draft a polite forum reply referencing this week’s material. Encourage discussion and add 1-2 thoughtful questions."
      : "Help prepare for an exam. Provide a study plan, likely topics, and how to approach tasks. If user requests, provide structured answers but remind them to use responsibly.";
  const userContent = `Task: ${task}
Extra Instruction: ${taskInstruction}

Materials:
---
${clamp(materialText)}
---

User Input:
${userInput ?? ""}`;
  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: 0.3,
    max_tokens: 1200,
  });
  return completion.choices?.[0]?.message?.content ?? "";
}
