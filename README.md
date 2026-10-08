# ILMATRIX (Hono + Groq)

> **2026 modernization:** Groq retired Llama 4 Maverick on 2026-03-09. ILMATRIX now runs on
> `openai/gpt-oss-120b` (fallback `openai/gpt-oss-20b`, vision `qwen/qwen3.8-27b`). See
> [docs/AUDIT_AND_STRATEGY_2026.md](docs/AUDIT_AND_STRATEGY_2026.md) for the full audit, model
> research, product positioning, pricing and roadmap.

An AI study companion for university students with **multimodal AI capabilities**. Core features:

- Upload course materials (PDF/DOCX/PPTX/TXT/Images) with **Vision API support**
- **Image Analysis**: Query visual content using a Groq vision model (configurable via `GROQ_VISION_MODEL`)
- **Smart Text Extraction**: OCR for images, preserve visual content for analysis## Storage & Retention

### What's Stored

- The app extracts text from uploaded files (PDF/DOCX/PPTX/Images/TXT) and stores only the extracted text as `uploads/<materialId>.txt`
- **Original files are never saved** - only the extracted text content

### Size Limits

- **10 MB total** per material (enforced at upload/append)
- Individual file size limits handled by extraction services

### Auto-Delete (TTL)

- Background cleaner deletes material files older than `MATERIAL_TTL_MINUTES` (default: 60 minutes)
- Runs at intervals with proper resource management (`unref()` timers for graceful shutdown)
- Implemented in [backgroundTaskService](src/services/backgroundTaskService.ts)

### PaaS Deployment

- On platforms with ephemeral disks, data may vanish on redeploy
- Use persistent volume/path for durability, or rely on TTL cleaner to prevent storage growth) and get help:
  - **Explain** material (concise + short citations)
  - **MCQ Quiz** (generate, answer with simple "1 a" format, deterministic grading, per-question feedback for wrong answers only)
  - **Flashcards** (auto‑generated flip cards from your materials)
  - **Forum** reply drafter
  - **Exam** helper (study‑first, responsible use)
  - **Chat** with context (optional, based on uploaded materials)
  - **Dialogue** (coached conversation; topic-based with 3 topics; Start/Begin/Send/Hint; grounded in uploaded materials)

Tech stack:

- **Hono.js** (Node adapter) for API and static hosting
- **Groq SDK** with OpenAI gpt-oss models (text) and a configurable vision model for images
- **TypeScript** (ESM, NodeNext) with clean architecture
- **Extraction**: pdfjs-dist (PDF), Groq Vision API (OCR for images), JSZip (DOCX/PPTX)
- **Tailwind CSS** (CDN)
- **Netlify-ready** (functions + static publish)

## Architecture Overview

The codebase follows **clean architecture principles** with clear separation of concerns:

- **Configuration**: Centralized environment management in `src/config/`
- **Services**: Business logic layer in `src/services/` (material, extraction, groq, MCQ scoring, background tasks)
- **Controllers**: HTTP request handling in `src/controllers/` (upload, material, AI endpoints)
- **Middleware**: Request processing in `src/middleware/` (rate limiting, etc.)
- **Utilities**: Shared helpers in `src/utils/` (security, concurrency, validation)
- **Routes**: Clean API route definitions in `src/routes.ts`

Key benefits:

- **Testable**: Services can be unit tested independently
- **Maintainable**: Clear module boundaries and dependencies
- **Scalable**: Easy to extend with new features or services
- **Type-safe**: Full TypeScript coverage with proper interfaces

## Testing

The project uses a comprehensive test suite with proper resource management:

- **Service Tests**: Unit tests for business logic services (MCQ scoring, validation, etc.)
- **Integration Tests**: API endpoint testing via Hono app fetch
- **Test Separation**: Services and integration tests run separately to prevent resource conflicts
- **Clean Exit**: Background tasks properly cleaned up with `unref()` timers and explicit cleanup hooks

Run tests:

```bash
npm test              # Full test suite (services + AI tools + integration)
npm run test:services # Service layer only (fast, no API calls)
npm run test:ai       # AI layer + every study tool endpoint, with a fake Groq client
npm run test:smoke    # Integration tests (API endpoints)
npm run groq:check    # Live check of every study tool against the real Groq API (needs GROQ_API_KEY)
```

Run `npm run groq:check` before deploying any model or SDK change: the automated tests use a fake Groq
client and cannot detect a model being retired or rejecting a parameter.

Test files:

- `tests/services/` - Service layer unit tests
- `tests/ai/` - AI provider unit tests and the study-tool regression suite
- `tests/smoke.test.ts` - API integration tests

## Development & Troubleshooting

### Common Issues

- **"Server is missing GROQ_API_KEY"**: Set `GROQ_API_KEY` in `.env` and restart server
- **Health check passes but UI fails**: Check browser console and network panel for errors
- **PDF extraction issues**: Try another PDF or verify `pdfjs-dist` is installed correctly
- **TypeScript module warnings**: Restart TS server/VS Code (runtime resolution works correctly)
- **Quiz generation fails**: The `extractJsonBlock` method in groqService properly handles JSON arrays
- **Tests hanging**: Background tasks use `unref()` and explicit cleanup for proper exit
- **Dialogue completion issues**: Fixed logic for final topic detection and "How am I doing?" status updates

### Recent Fixes & Improvements

- ✅ **Complete refactoring** to clean architecture with services/controllers separation
- ✅ **Quiz functionality** fixed with proper JSON array parsing for MCQ generation
- ✅ **Dialogue feature** fully implemented with proper completion detection
- ✅ **Test suite** runs cleanly without hanging (10 tests total: 7 service + 3 integration)
- ✅ **Background task management** with proper resource cleanup using `unref()` timers
- ✅ **"How am I doing?" logic** fixed to show correct completion status

- Upload course materials (PDF/TXT/Images/DOCX/PPTX) and get help:
  - Explain material (concise + short citations)
  - MCQ Quiz (generate, answer with simple “1 a” format, deterministic grading, per-question feedback for wrong answers only)
  - Flashcards (auto‑generated flip cards from your materials)
  - Forum reply drafter
  - Exam helper (study‑first, responsible use)
  - Chat with context (optional, based on uploaded materials)
  - Dialogue (coached conversation; topic-based with 3 topics; Start/Begin/Send/Hint; grounded in uploaded materials)

Tech stack:

- Hono.js (Node adapter) for API and static hosting
- Groq SDK with OpenAI gpt-oss models (text) and a configurable vision model for images
- TypeScript (ESM, NodeNext) with clean architecture
- Extraction: pdfjs-dist (PDF), Groq Vision API (OCR for images), JSZip (DOCX/PPTX)
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
# GROQ_MODEL=openai/gpt-oss-120b
```

3. Run in development:

```bash
npm run dev
```

Server (default): <http://localhost:8787>

## Open the UI

- Home (marketing): <http://localhost:8787/> (public/index.html)
- App (features): <http://localhost:8787/app.html>

## Environment variables

- GROQ_API_KEY: Your Groq API key (required)
- GROQ_MODEL: Primary text model (default `openai/gpt-oss-120b`). Retired model IDs (e.g. Llama 4 Maverick) are remapped to Groq's recommended replacement with a warning.
- GROQ_FALLBACK_MODEL: Used when the primary model is rate limited, down or decommissioned (default `openai/gpt-oss-20b`; empty disables).
- GROQ_VISION_MODEL: Model for images (OCR and image questions in chat). Default `qwen/qwen3.8-27b`, a **Preview** model on Groq; empty disables vision and chat falls back to text-only.
- GROQ_REASONING_EFFORT: Reasoning effort for free-form answers (`low` | `medium` | `high`, default `medium`). JSON tools always use `low`.
- GROQ_STRUCTURED_OUTPUTS: Use strict JSON-schema outputs for quiz/flashcard/dialogue tools (default `true`). Rejected schemas automatically fall back to JSON mode.
- PORT: Server port (default: 8787)
- MATERIAL_CLAMP: Max characters of materials included per request (default 100000). Increase for better recall (higher cost), decrease to save tokens.
- MATERIAL_TTL_MINUTES: Minutes to keep uploaded materials before auto-deletion (default 60). A background cleaner periodically removes old .txt material files from the uploads folder. See [src/routes.ts](src/routes.ts:735).
- RATE_LIMIT_MAX: Requests per minute per IP (default 120). Lightweight token bucket applied to all /api routes. See [middleware](src/routes.ts:70).
- PDF_MAX_PAGES: Max PDF pages extracted per file (default 200). See [extractPdfTextImpl()](src/extract/pdf.ts:50).
- GROQ_CONCURRENCY: Concurrent LLM requests per process, including image OCR (default 4). See [groqProvider](src/services/groqProvider.ts).
- GROQ_TIMEOUT_MS: Per-request LLM timeout in ms, enforced by the Groq SDK (default 45000). See [groqProvider](src/services/groqProvider.ts).
- EXTRACTION_CONCURRENCY: Max concurrent file extraction operations (default 2). See [extractionService](src/services/extractionService.ts).

## Storage & retention

- What’s stored:
  - The app extracts text from your uploaded files (PDF/DOCX/PPTX/Images/TXT) and stores only the extracted text as uploads/&lt;materialId&gt;.txt. Originals are not saved.
- Size limits:
  - 10 MB total per material (enforced at upload/append).
- Auto delete (TTL):
  - A background cleaner deletes material .txt files older than MATERIAL_TTL_MINUTES (default 60). This runs at intervals and is designed to be resilient. Implemented in [src/routes.ts](src/routes.ts).
- Persistence on PaaS:
  - If you deploy to platforms with ephemeral disks, data may vanish on redeploy. Use a persistent volume/path if you need durability, or rely on the default TTL cleaner to avoid storage growth.

## Security & accessibility

- Security hardening:
  - Path traversal protection for materials I/O; only UUID v4-like ids are accepted and paths are validated inside uploads/ (see [security utils](src/utils/security.ts)).
  - Global per-IP rate limiting (default 120 req/min) via a lightweight token bucket (see [rate limit middleware](src/middleware/rateLimit.ts)). Tune with RATE_LIMIT_MAX.
  - CSP applied to static pages to restrict sources (see [app](public/app.html), [index](public/index.html), [about](public/about.html)).
  - Best-effort Content-Length guard on uploads to quickly reject oversized requests (see [upload controller](src/controllers/uploadController.ts)).
- Accessibility:
  - Live regions announce new chat and dialogue messages for screen readers (see [app live regions](public/app.html)).
  - Tool trigger buttons include aria-label/controls/expanded for improved navigation.

Note on SRI (Subresource Integrity): in production, pin CDN versions and add integrity/crossorigin attributes for Tailwind, marked, and DOMPurify.

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

- **Dialogue** (Coached Conversation)

  - **POST /api/dialogue/start**
    - Body: `{ materialId: string }`
    - Response: `{ sessionId, language, intro, topics: [{ id, title }], firstCoachPrompt }`
  - **POST /api/dialogue/step**
    - Body: `{ materialId: string, topics: Array<{ id:number, title:string }>, currentTopicIndex: number, userMessage: string, lastCoachQuestion?: string, language?: "id"|"en" }`
    - Response: `{ coachMessage: string, addressed: boolean, moveToNext: boolean, nextCoachQuestion?: string, isComplete?: boolean }`
    - Special: `userMessage: "How am I doing?"` returns progress status
  - **POST /api/dialogue/hint**
    - Body: `{ materialId: string, currentTopicTitle: string, language?: "id"|"en" }`
    - Response: `{ hint: string }`
  - **POST /api/dialogue/feedback**
    - Body: `{ materialId: string, topics: Array<{ id:number, title:string }>, history?: Array<{ role:"coach"|"user"|"ilmatrix"|"system", content:string }>, language?: "id"|"en" }`
    - Response: `{ feedback: string, strengths: string[], improvements: string[] }`

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

- Open <http://localhost:8787/app.html>
- Drag & drop or click the upload drop zone to select multiple files. Upload starts automatically:
  - The first batch creates a new materialId.
  - Subsequent drops/selections append to the same material automatically (10 MB total cap).
  - Remove any file’s content from the current material by clicking “Remove” next to it.
  - Use “Remove all” on the attachments bar to clear the current material’s files at once.
  - Use “Start new material” to reset the client-side materialId and begin a new one (existing materials remain on disk).
- Use tabs:
  - Explain: prompt and run
  - Quiz (MCQ): generate; answer with “1 a”, “2 b”, …; submit & grade
  - Flashcards: generate N; click cards to flip (front/back)
  - Forum: draft reply
  - Exam: helper plan
  - Chat: general with optional context
  - Dialogue: coached session (Start → “Let’s get started!” → Send). Use “I’m stuck” for a short hint; after 3 topics you’ll get final feedback.
    - Mobile: a local “+” button next to the Dialogue input opens quick actions; the global floating “+” is hidden on Dialogue to avoid duplicates.
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
- Groq vision model for images (`GROQ_VISION_MODEL`); if vision is unavailable the image is kept for later analysis
- JSZip for DOCX/PPTX (extracts text from XML)
- Plain text files read directly

## Development scripts

- npm run dev → start with hot reload
- npm run start → start without nodemon
- npm run build → type-check and emit
- npm test → run complete test suite (services + AI tools + smoke tests)
- npm run test:services → run service layer unit tests
- npm run test:ai → run AI layer and study-tool regression tests (fake Groq client)
- npm run test:smoke → run API integration tests
- npm run groq:check → live check of every study tool against Groq (needs GROQ_API_KEY)

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

Apache-2.0 License
