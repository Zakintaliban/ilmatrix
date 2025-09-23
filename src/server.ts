import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import api, { stopMaterialCleaner } from "./routes.js";
import { createServer } from "node:net";

/** Ilmatrix server bootstrap */
const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));

app.route("/api", api);

// Serve frontend
app.use("/*", serveStatic({ root: "./public" }));
app.get("/", (c) => c.redirect("/index.html"));

const basePort = Number(process.env.PORT || 8787);
const model =
  process.env.GROQ_MODEL || "meta-llama/llama-4-maverick-17b-128e-instruct";

function findOpenPort(start: number, attempts = 10): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number, left: number) => {
      const tester = createServer()
        .once("error", (err: any) => {
          if ((err as any)?.code === "EADDRINUSE" && left > 0) {
            tryPort(p + 1, left - 1);
          } else {
            reject(err);
          }
        })
        .once("listening", () => {
          tester.close(() => resolve(p));
        })
        .listen(p);
    };
    tryPort(start, attempts);
  });
}

findOpenPort(basePort)
  .then((port) => {
    console.log(
      `[Ilmatrix] starting on http://localhost:${port} (model=${model})`
    );
    const server: any = serve({ fetch: app.fetch, port }) as any;

    const closeServer = (
      server && typeof server.close === "function"
        ? () => {
            try {
              server.close();
            } catch {}
          }
        : undefined
    ) as undefined | (() => void);

    const shutdown = (code = 0) => {
      try {
        stopMaterialCleaner?.();
      } catch {}
      try {
        closeServer?.();
      } catch {}
      try {
        if (code !== null) process.exit(code);
      } catch {}
    };

    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
    process.on("beforeExit", () => {
      try {
        stopMaterialCleaner?.();
      } catch {}
      try {
        closeServer?.();
      } catch {}
    });
  })
  .catch((err) => {
    console.error("Failed to bind to a port:", err);
    process.exit(1);
  });
