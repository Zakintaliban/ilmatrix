/** Request body size limits on the API (S14), through the real routes. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import api, { stopBackgroundTasks } from "../../src/routes.js";
import config from "../../src/config/env.js";

after(() => {
  stopBackgroundTasks();
  setTimeout(() => process.exit(0), 100).unref();
});

const MB = 1024 * 1024;

function streamOf(bytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) return controller.close();
      controller.enqueue(chunk);
      sent += chunk.length;
    },
  });
}

test("JSON bodies over 2 MB are refused with 413", async () => {
  const body = JSON.stringify({ materialText: "a".repeat(2 * MB + 10) });
  const res = await api.fetch(new Request("http://local/explain", { method: "POST", headers: { "content-type": "application/json" }, body }));
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, "BODY_TOO_LARGE");
});

test("the limit holds without a Content-Length (chunked body)", async () => {
  const req = new Request("http://local/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: streamOf(3 * MB),
    duplex: "half",
  } as RequestInit);
  assert.equal(req.headers.get("content-length"), null);
  const res = await api.fetch(req);
  assert.equal(res.status, 413);
});

test("normal JSON bodies are not affected", async () => {
  const res = await api.fetch(
    new Request("http://local/quiz/trainer/mcq/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questions: [], userAnswers: {}, pad: "x".repeat(MB) }),
    })
  );
  assert.equal(res.status, 200);
});

test("uploads may use the file limit, but not more", async () => {
  const form = (bytes: number) => {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(bytes).fill(0x61)], { type: "text/plain" }), "catatan.txt");
    return fd;
  };
  const big = await api.fetch(new Request("http://local/upload", { method: "POST", body: form(config.uploadMaxSizeBytes + 2 * MB) }));
  assert.equal(big.status, 413);

  const ok = await api.fetch(new Request("http://local/upload", { method: "POST", body: form(3 * MB) }));
  assert.notEqual(ok.status, 413, "a 3 MB upload is over the JSON limit but fine for /upload");
});
