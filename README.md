# ILMATRIX (Hono + Groq + Meta Llama)

An AI study companion for university students. Core features:

- Upload course materials (PDF/TXT/Images/DOCX/PPTX) and get help:
  - Explain material (concise + short citations)
  - MCQ Quiz (generate, answer with simple “1 a” format, deterministic grading, per-question feedback for wrong answers only)
  - Flashcards (auto‑generated flip cards from your materials)
  - Forum reply drafter
  - Exam helper (study‑first, responsible use)
  - Chat with context (optional, based on uploaded materials)

Tech stack:

- Hono.js (Node adapter) for API and static hosting
- Groq SDK with Meta Llama models
- TypeScript (ESM, NodeNext)
- Extraction: pdfjs-dist (PDF), tesseract.js (OCR for images), JSZip (DOCX/PPTX)
- Tailwind CSS (CDN)
- Netlify-ready (functions + static publish)

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
# Edit .env and set your Groq key
# GROQ_API_KEY=sk_...
# Optional:
# GROQ_MODEL=meta-llama/llama-4-maverick-17b-128e-instruct
```

3. Run in development:

```bash
npm run dev
```

Server (default): http://localhost:8787

## Open the UI

- Home (marketing): http://localhost:8787/ (public/index.html)
- App (features): http://localhost:8787/app.html

## Environment variables

- GROQ_API_KEY: Your Groq API key (required)
- GROQ_MODEL: Groq model id (default set in code)
- PORT: Server port (default: 8787)

## API

Base: /api

- GET /api/health → { "ok": true, "uptime": number }

- POST /api/upload (multipart/form-data)

  - Field "file": may appear multiple times to upload multiple files in one batch (PDF/TXT/PNG/JPG/DOCX/PPTX)
  - Optional when appending to an existing material: append=true, mergeTo=<materialId> (or materialId=<id>)
  - Response: { "materialId": "uuid", "appended": boolean, "files": number, "size": number, "sizeAdded": number, "limit": "10MB" }

- POST /api/explain (application/json)

  - Body: { materialId?: string, materialText?: string, prompt?: string }
  - Response: { "answer": string }

- POST /api/quiz (application/json)

  - Body: { materialId?: string, materialText?: string, prompt?: string, numQuestions?: number }
  - Response: { "answer": string } // may include “Jawaban” section

- POST /api/forum (application/json)

  - Body: { materialId?: string, materialText?: string, prompt?: string }
  - Response: { "answer": string }

- POST /api/exam (application/json)

  - Body: { materialId?: string, materialText?: string, prompt?: string }
  - Response: { "answer": string }

- MCQ Trainer (deterministic)

  - POST /api/quiz/trainer/mcq/start
    - { materialId: string, numQuestions: number }
    - → { questions: [{ id, question, options[5], answer, rationale, weaknesses[], studyPlan[] }] }
  - POST /api/quiz/trainer/mcq/score
    - { materialId: string, questions: [...], userAnswers: { [id]: "A|B|C|D|E" } }
    - → { analysis: string } // Score X/Y, per-question lines; for wrong answers prints explanation + weaknesses + study plan; ends with “Jawaban”

- Flashcards

  - POST /api/flashcards
    - { materialId: string, numCards: number }
    - → { cards: [{ id, front, back }] }

- Materials
  - GET /api/material/:id
    - → { materialId: string, totalSize: number, files: [{ name: string, size: number, occurrences: number }] }
  - POST /api/material/:id/remove
    - Body: { name: string }
    - → { materialId: string, removed: string, totalSize: number, files: [{ name, size, occurrences }] }

## cURL examples

```bash
# Upload multiple files (new material)
curl -F "file=@notes.pdf" -F "file=@slides.pptx" http://localhost:8787/api/upload

# Append to existing material
curl -F "append=true" -F "mergeTo=UUID" -F "file=@more.docx" http://localhost:8787/api/upload

# List files inside a material
curl http://localhost:8787/api/material/UUID

# Remove a file's content from a material (destructive)
curl -H "Content-Type: application/json" \
  -d "{\"name\":\"slides.pptx\"}" \
  http://localhost:8787/api/material/UUID/remove

# Explain with uploaded material
curl -H "Content-Type: application/json" \
  -d "{\"materialId\":\"UUID\",\"prompt\":\"Ringkas bab 2\"}" \
  http://localhost:8787/api/explain

# Generate quiz (legacy helper)
curl -H "Content-Type: application/json" \
  -d "{\"materialId\":\"UUID\",\"numQuestions\":5}" \
  http://localhost:8787/api/quiz

# MCQ generate (deterministic flow)
curl -H "Content-Type: application/json" \
  -d "{\"materialId\":\"UUID\",\"numQuestions\":5}" \
  http://localhost:8787/api/quiz/trainer/mcq/start

# MCQ score
curl -H "Content-Type: application/json" \
  -d "{\"materialId\":\"UUID\",\"questions\":[...],\"userAnswers\":{\"1\":\"A\",\"2\":\"B\"}}" \
  http://localhost:8787/api/quiz/trainer/mcq/score

# Flashcards (generate 5)
curl -H "Content-Type: application/json" \
  -d "{\"materialId\":\"UUID\",\"numCards\":5}" \
  http://localhost:8787/api/flashcards
```

## Frontend usage

- Open http://localhost:8787/app.html
- Drag & drop or click the upload drop zone to select multiple files. Upload starts automatically:
  - The first batch creates a new materialId.
  - Subsequent drops/selections append to the same material automatically (10 MB total cap).
  - Remove any file’s content from the current material by clicking “Remove” next to it.
  - Use “Start new material” to reset the client-side materialId and begin a new one (existing materials remain on disk).
- Use tabs:
  - Explain: prompt and run
  - Quiz (MCQ): generate; answer with “1 a”, “2 b”, …; submit & grade
  - Flashcards: generate N; click cards to flip (front/back)
  - Forum: draft reply
  - Exam: helper plan
  - Chat: general with optional context
- Results appear within each section (no result-only tab)

## Prompts and guardrails

- System prompt:
  - Use materials as primary source; include short quotes (≤120 chars)
  - Concise, structured, actionable output
  - For quiz/exam: emphasize learning; provide final answers with brief justification only (no chain-of-thought)
  - Integrity and safety
- MCQ flow:
  - Generation embeds answer + rationale + weaknesses + studyPlan per question (Groq)
  - Scoring is deterministic on backend (simple rules), no LLM call

## Extraction

- pdfjs-dist for PDFs (fonts/CMaps wired)
- tesseract.js OCR for images (eng+ind → eng fallback)
- JSZip for DOCX/PPTX (extracts text from XML)
- Plain text files read directly

## Development scripts

- npm run dev → start with hot reload
- npm run start → start without nodemon
- npm run build → type-check and emit

## Notes and next steps

- Current MVP uses upload-only materials (no LMS integration yet)
- Consider:
  - Authentication + per-user storage/history
  - Vector search for large materials
  - Rate limiting and quotas
  - More UI polish (markdown rendering, persistence)
  - SSE streaming for faster perceived latency

## Troubleshooting

- “Server is missing GROQ_API_KEY”: set GROQ_API_KEY in .env and restart
- Health is ok but UI fails: check browser console and network panel
- PDF extraction issues: try another PDF or verify pdfjs-dist is installed
- TypeScript module warnings in editor: restart TS server/VS Code (runtime resolution is correct)

## License

MIT (or your preferred license)
