import test from "node:test";
import assert from "node:assert/strict";
import { mcqScoringService } from "../../src/services/mcqScoringService.js";

const sampleQuestions = [
  {
    id: 1,
    question: "What is 2+2?",
    options: ["3", "4", "5", "6", "7"],
    answer: "B",
    rationale: "Basic addition: 2+2=4",
    weaknesses: ["Calculation errors", "Not understanding addition"],
    studyPlan: ["Practice basic arithmetic", "Review addition concepts"],
  },
  {
    id: 2,
    question: "What is the capital of France?",
    options: ["London", "Berlin", "Paris", "Madrid", "Rome"],
    answer: "C",
    rationale: "Paris is the capital and largest city of France",
    weaknesses: ["Geographic confusion", "Not studying European capitals"],
    studyPlan: ["Study European geography", "Memorize capital cities"],
  },
];

test("MCQ Scoring Service - Perfect Score", async () => {
  const userAnswers = { "1": "B", "2": "C" };
  const result = mcqScoringService.scoreQuiz(sampleQuestions, userAnswers);

  assert.equal(result.score, 2);
  assert.equal(result.total, 2);
  assert.equal(result.percentage, 100);
  assert.deepEqual(result.correctAnswers, [1, 2]);
  assert.deepEqual(result.incorrectAnswers, []);
  assert.ok(result.analysis.includes("Score: 2/2"));
  assert.ok(result.analysis.includes("✓ Correct"));
  assert.ok(result.analysis.includes("Jawaban"));
});

test("MCQ Scoring Service - Partial Score", async () => {
  const userAnswers = { "1": "A", "2": "C" }; // First wrong, second correct
  const result = mcqScoringService.scoreQuiz(sampleQuestions, userAnswers);

  assert.equal(result.score, 1);
  assert.equal(result.total, 2);
  assert.equal(result.percentage, 50);
  assert.deepEqual(result.correctAnswers, [2]);
  assert.deepEqual(result.incorrectAnswers, [1]);
  assert.ok(result.analysis.includes("Score: 1/2"));
  assert.ok(result.analysis.includes("✗ Wrong"));
  assert.ok(result.analysis.includes("Your answer: A"));
  assert.ok(result.analysis.includes("Correct answer: B"));
  assert.ok(result.analysis.includes("Basic addition: 2+2=4"));
});

test("MCQ Scoring Service - Empty Quiz", async () => {
  const result = mcqScoringService.scoreQuiz([], {});

  assert.equal(result.score, 0);
  assert.equal(result.total, 0);
  assert.equal(result.percentage, 0);
  assert.ok(result.analysis.includes("Score: 0/0"));
  assert.ok(result.analysis.includes("No questions to score"));
});

test("MCQ Scoring Service - Parse Answers", async () => {
  const answerText = "1 a\n2 b\n3 c";
  const parsed = mcqScoringService.parseAnswers(answerText, sampleQuestions);

  assert.deepEqual(parsed, { "1": "A", "2": "B", "3": "C" });
});

test("MCQ Scoring Service - Parse Answers with Commas", async () => {
  const answerText = "1 a, 2 b, 3 c";
  const parsed = mcqScoringService.parseAnswers(answerText, sampleQuestions);

  assert.deepEqual(parsed, { "1": "A", "2": "B", "3": "C" });
});

test("MCQ Scoring Service - Validate Answers", async () => {
  const completeAnswers = { "1": "B", "2": "C" };
  const incompleteAnswers = { "1": "B" };
  const invalidAnswers = { "1": "X", "2": "C" };

  const completeValidation = mcqScoringService.validateAnswers(
    sampleQuestions,
    completeAnswers
  );
  assert.equal(completeValidation.valid, true);
  assert.equal(completeValidation.missing.length, 0);
  assert.equal(completeValidation.invalid.length, 0);

  const incompleteValidation = mcqScoringService.validateAnswers(
    sampleQuestions,
    incompleteAnswers
  );
  assert.equal(incompleteValidation.valid, false);
  assert.deepEqual(incompleteValidation.missing, [2]);

  const invalidValidation = mcqScoringService.validateAnswers(
    sampleQuestions,
    invalidAnswers
  );
  assert.equal(invalidValidation.valid, false);
  assert.equal(invalidValidation.invalid.length, 1);
  assert.ok(invalidValidation.invalid[0].includes("X"));
});

test("MCQ Scoring Service - Answer Statistics", async () => {
  const userAnswers = { "1": "A", "2": "C" };
  const stats = mcqScoringService.getAnswerStats(sampleQuestions, userAnswers);

  assert.equal(stats.answered, 2);
  assert.equal(stats.unanswered, 0);
  assert.equal(stats.answerDistribution.A, 1);
  assert.equal(stats.answerDistribution.C, 1);
  assert.equal(stats.answerDistribution.B, 0);
});
