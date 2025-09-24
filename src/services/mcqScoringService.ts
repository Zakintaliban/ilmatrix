import type { QuizQuestion } from "./groqService.js";

export interface UserAnswers {
  [questionId: string]: string;
}

export interface ScoreResult {
  analysis: string;
  score: number;
  total: number;
  percentage: number;
  correctAnswers: number[];
  incorrectAnswers: number[];
}

/**
 * Service for deterministic MCQ scoring without LLM calls
 */
export class MCQScoringService {
  /**
   * Score quiz answers deterministically
   */
  scoreQuiz(questions: QuizQuestion[], userAnswers: UserAnswers): ScoreResult {
    if (!questions.length) {
      return {
        analysis: "Score: 0/0\n\nNo questions to score.\n\nJawaban",
        score: 0,
        total: 0,
        percentage: 0,
        correctAnswers: [],
        incorrectAnswers: [],
      };
    }

    const results: string[] = [];
    let correctCount = 0;
    const correctAnswers: number[] = [];
    const incorrectAnswers: number[] = [];

    results.push(`Score: ?/${questions.length}\n`);

    for (const question of questions) {
      const questionId = String(question.id);
      const userAnswer = userAnswers[questionId]?.toUpperCase();
      const correctAnswer = question.answer?.toUpperCase();
      const isCorrect = userAnswer === correctAnswer;

      if (isCorrect) {
        correctCount++;
        correctAnswers.push(question.id);
        results.push(`${question.id}) ✓ Correct`);
      } else {
        incorrectAnswers.push(question.id);

        // For wrong answers, provide detailed feedback
        results.push(`${question.id}) ✗ Wrong`);

        if (userAnswer) {
          results.push(`   Your answer: ${userAnswer}`);
        } else {
          results.push(`   Your answer: (not provided)`);
        }

        results.push(`   Correct answer: ${correctAnswer}`);

        if (question.rationale) {
          results.push(`   Explanation: ${question.rationale}`);
        }

        if (question.weaknesses?.length) {
          results.push(`   Common mistakes:`);
          question.weaknesses.forEach((weakness) => {
            results.push(`   • ${weakness}`);
          });
        }

        if (question.studyPlan?.length) {
          results.push(`   Study suggestions:`);
          question.studyPlan.forEach((suggestion) => {
            results.push(`   • ${suggestion}`);
          });
        }

        results.push(""); // Add blank line between questions
      }
    }

    // Update the score line
    results[0] = `Score: ${correctCount}/${questions.length}`;

    // Add final "Jawaban" marker
    results.push("Jawaban");

    const percentage =
      questions.length > 0
        ? Math.round((correctCount / questions.length) * 100)
        : 0;

    return {
      analysis: results.join("\n"),
      score: correctCount,
      total: questions.length,
      percentage,
      correctAnswers,
      incorrectAnswers,
    };
  }

  /**
   * Parse user answers from text input
   * Supports formats like "1 a", "2 b", etc.
   */
  parseAnswers(text: string, questions: QuizQuestion[]): UserAnswers {
    const tokens = String(text || "")
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter(Boolean);

    const userAnswers: UserAnswers = {};

    for (const token of tokens) {
      const match = token.match(/^\s*(\d+)\s*([a-eA-E])\s*$/);
      if (match) {
        const questionNum = match[1];
        const answer = match[2].toUpperCase();
        userAnswers[questionNum] = answer;
      }
    }

    return userAnswers;
  }

  /**
   * Validate that all questions have been answered
   */
  validateAnswers(
    questions: QuizQuestion[],
    userAnswers: UserAnswers
  ): {
    valid: boolean;
    missing: number[];
    invalid: string[];
  } {
    const missing: number[] = [];
    const invalid: string[] = [];
    const validOptions = ["A", "B", "C", "D", "E"];

    for (const question of questions) {
      const questionId = String(question.id);
      const answer = userAnswers[questionId];

      if (!answer) {
        missing.push(question.id);
      } else if (!validOptions.includes(answer.toUpperCase())) {
        invalid.push(
          `Question ${question.id}: "${answer}" is not a valid option (use A-E)`
        );
      }
    }

    return {
      valid: missing.length === 0 && invalid.length === 0,
      missing,
      invalid,
    };
  }

  /**
   * Get answer statistics
   */
  getAnswerStats(
    questions: QuizQuestion[],
    userAnswers: UserAnswers
  ): {
    answered: number;
    unanswered: number;
    answerDistribution: Record<string, number>;
  } {
    const answerDistribution: Record<string, number> = {
      A: 0,
      B: 0,
      C: 0,
      D: 0,
      E: 0,
    };

    let answered = 0;

    for (const question of questions) {
      const questionId = String(question.id);
      const answer = userAnswers[questionId]?.toUpperCase();

      if (answer && answerDistribution.hasOwnProperty(answer)) {
        answered++;
        answerDistribution[answer]++;
      }
    }

    return {
      answered,
      unanswered: questions.length - answered,
      answerDistribution,
    };
  }
}

// Export singleton instance
export const mcqScoringService = new MCQScoringService();
