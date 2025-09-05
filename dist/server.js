import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import api from "./routes.js";
import { createServer } from "node:net";
/** StudyAI server bootstrap */
const app = new Hono();
app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api", api);
// Serve frontend
app.use("/*", serveStatic({ root: "./public" }));
app.get("/", (c) => c.redirect("/index.html"));
const basePort = Number(process.env.PORT || 8787);
const model = process.env.GROQ_MODEL || "llama-3.1-70b-versatile";
function findOpenPort(start, attempts = 10) {
    return new Promise((resolve, reject) => {
        const tryPort = (p, left) => {
            const tester = createServer()
                .once("error", (err) => {
                if (err?.code === "EADDRINUSE" && left > 0) {
                    tryPort(p + 1, left - 1);
                }
                else {
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
    console.log(`[StudyAI] starting on http://localhost:${port} (model=${model})`);
    serve({ fetch: app.fetch, port });
})
    .catch((err) => {
    console.error("Failed to bind to a port:", err);
    process.exit(1);
});
