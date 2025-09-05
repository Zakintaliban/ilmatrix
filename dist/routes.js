import { Hono } from "hono";
import { promises as fs } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { extractPdfText } from "./extract/pdf.js";
import { generateAnswer } from "./groqClient.js";
const defaultRoot = process.env.NETLIFY ? "/tmp" : process.cwd();
const uploadsDir = join(defaultRoot, "uploads");
async function ensureUploads() {
    await fs.mkdir(uploadsDir, { recursive: true });
}
async function readMaterial(materialId, materialText) {
    if (materialText && materialText.trim())
        return materialText;
    if (!materialId)
        throw new Error("materialId or materialText is required");
    return await fs.readFile(join(uploadsDir, `${materialId}.txt`), "utf8");
}
const api = new Hono();
api.post("/upload", async (c) => {
    try {
        await ensureUploads();
        const body = await c.req.parseBody();
        const file = body["file"];
        if (!file || typeof file.arrayBuffer !== "function") {
            return c.json({ error: 'Provide multipart/form-data with field "file" (PDF or TXT)' }, 400);
        }
        const name = file.name ?? "file";
        const type = file.type ?? "";
        const id = randomUUID();
        let text = "";
        if (type.includes("pdf") || name.toLowerCase().endsWith(".pdf")) {
            const ab = await file.arrayBuffer();
            text = await extractPdfText(Buffer.from(ab));
        }
        else if (type.includes("text") || name.toLowerCase().endsWith(".txt")) {
            // Some runtimes support file.text()
            if (typeof file.text === "function") {
                text = await file.text();
            }
            else {
                const ab = await file.arrayBuffer();
                text = Buffer.from(ab).toString("utf8");
            }
        }
        else {
            return c.json({ error: "Unsupported file type. Use PDF or TXT." }, 400);
        }
        await fs.writeFile(join(uploadsDir, `${id}.txt`), text, "utf8");
        return c.json({ materialId: id, size: text.length });
    }
    catch (err) {
        console.error(err);
        return c.json({ error: "Upload failed", detail: err?.message }, 500);
    }
});
api.post("/explain", async (c) => {
    try {
        const { materialId, materialText, prompt } = await c.req.json();
        const text = await readMaterial(materialId, materialText);
        const answer = await generateAnswer({
            task: "explain",
            materialText: text,
            userInput: prompt,
        });
        return c.json({ answer });
    }
    catch (err) {
        console.error(err);
        return c.json({ error: "Explain failed", detail: err?.message }, 500);
    }
});
api.post("/quiz", async (c) => {
    try {
        const { materialId, materialText, prompt, numQuestions } = await c.req.json();
        const text = await readMaterial(materialId, materialText);
        const answer = await generateAnswer({
            task: "quiz",
            materialText: text,
            userInput: JSON.stringify({ prompt, numQuestions: numQuestions ?? 5 }),
        });
        return c.json({ answer });
    }
    catch (err) {
        console.error(err);
        return c.json({ error: "Quiz failed", detail: err?.message }, 500);
    }
});
api.post("/forum", async (c) => {
    try {
        const { materialId, materialText, prompt } = await c.req.json();
        const text = await readMaterial(materialId, materialText);
        const answer = await generateAnswer({
            task: "forum",
            materialText: text,
            userInput: prompt,
        });
        return c.json({ answer });
    }
    catch (err) {
        console.error(err);
        return c.json({ error: "Forum failed", detail: err?.message }, 500);
    }
});
api.post("/exam", async (c) => {
    try {
        const { materialId, materialText, prompt } = await c.req.json();
        const text = await readMaterial(materialId, materialText);
        const answer = await generateAnswer({
            task: "exam",
            materialText: text,
            userInput: prompt,
        });
        return c.json({ answer });
    }
    catch (err) {
        console.error(err);
        return c.json({ error: "Exam helper failed", detail: err?.message }, 500);
    }
});
export default api;
