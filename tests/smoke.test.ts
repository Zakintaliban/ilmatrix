import test from "node:test";
import assert from "node:assert/strict";
import api from "../src/routes.ts";

// Helper to parse JSON response body
async function json(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text };
  }
}

test("GET /material/:id with invalid id returns 400", async () => {
  const res = await api.fetch(
    new Request("http://local/material/invalid-id", { method: "GET" })
  );
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.ok(
    body.error?.toLowerCase().includes("invalid"),
    "should return invalid material id"
  );
});

test("POST /chat behaves correctly with or without GROQ_API_KEY", async () => {
  const payload = {
    materialText: "",
    messages: [{ role: "user", content: "hello" }],
  };
  const req = new Request("http://local/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const res = await api.fetch(req);
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.ok(typeof body.answer === "string", "answer should be a string");

  const hasKey = !!process.env.GROQ_API_KEY;
  if (!hasKey) {
    // When key is missing, backend returns a human message string in 'answer'
    assert.ok(
      body.answer.includes("GROQ_API_KEY") ||
        body.answer.toLowerCase().includes("missing"),
      "answer should mention missing API key when GROQ_API_KEY is not set"
    );
  }
});

test("POST /quiz/trainer/mcq/score with empty set returns analysis string", async () => {
  const payload = {
    materialText: "",
    questions: [],
    userAnswers: {},
  };
  const req = new Request("http://local/quiz/trainer/mcq/score", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const res = await api.fetch(req);
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.ok(typeof body.analysis === "string", "analysis should be a string");
  assert.ok(body.analysis.includes("Score:"), "analysis contains score line");
});
