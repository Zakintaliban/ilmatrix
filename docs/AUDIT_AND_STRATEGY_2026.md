# ILMATRIX — Audit, Market Research & Modernization Plan (October 2026)

> Status: **report for approval.** Only the non-architectural P0 fixes listed in §19.1 are implemented on this branch.
> Everything in §19.2 is waiting for a decision from the owner.
>
> Research date: 8 Oct 2026. Groq's documentation domain (`console.groq.com`) and API (`api.groq.com`) were **blocked by the
> sandbox's network policy**, so Groq facts come from web search over Groq's docs plus third-party trackers (cited). Nothing
> in this branch has been executed against the live Groq API. Run `npm run groq:check` with a real key before deploying.

---

## 0. Executive summary (read this if nothing else)

1. **The app is currently broken.** Every AI feature calls `meta-llama/llama-4-maverick-17b-128e-instruct`, which Groq
   **shut down on 9 March 2026** ([Groq deprecations](https://console.groq.com/docs/deprecations)). Image OCR fails silently
   (it falls back to storing raw base64). A fresh deploy would also fail to *start*, because `.npmrc` sets `omit=dev`
   while `npm start` runs `tsx` (a dev dependency). I verified this with a clean `npm ci`.
2. **There are no LLM "tools" in this codebase.** The repository contains zero function calling, `tools`, `tool_calls`,
   MCP, structured outputs or streaming. The "tools" are **8 user-facing study tools** (Explain, Quiz, Forum, Exam, Chat,
   MCQ Trainer, Flashcards, Dialogue Coach). Each one is a prompt template behind a REST endpoint. All of them are
   inventoried in §3 and all are preserved.
3. **Model:** migrate to **`openai/gpt-oss-120b`** (Groq's official replacement, production, $0.15/$0.60 per M tokens,
   131k context, strict JSON-schema outputs), with **`openai/gpt-oss-20b`** as automatic fallback. gpt-oss is text-only, so
   images go to **`qwen/qwen3.8-27b`**. That is Groq's only vision model and it is still **Preview**, so it is built
   behind a flag that degrades gracefully when the model is unavailable.
4. **The product question, answered bluntly:** as currently built, ILMATRIX is a weaker, paid version of
   **NotebookLM, which is free**. On top of that, Google is giving Indonesian university students **Google AI Plus free for
   12 months** (claims open until 31 Dec 2026). Nobody will pay for "upload a PDF and chat with it". Students *will* pay for
   **getting through a specific exam**. That means mock UTS/UAS built from the lecturer's own slides, a persistent map of
   weak topics, and a learning-first tutor that doesn't hand out answers, sold at exam time for the price of a snack.
5. **The economics work. AI tokens are not the problem.** A typical grounded answer on gpt-oss-120b costs **≈ Rp35**,
   and a typical paying student costs **Rp3–6k/month** in Groq usage. The risks are **conversion** and **free/guest abuse**
   (the guest limit can currently be bypassed without limit by not sending a cookie).
6. **Recommended pricing:** Free (capped) · **Pass 7 Hari Rp9.900** · **Semester Rp99.000** (the hero offer, priced under
   the Rp100k QRIS 0%-MDR threshold) · Bulanan Rp29.000 · top-ups. All are metered in cost-weighted *kredit*, which caps
   the worst-case COGS for every plan.

---

## 1. Current architecture

| Layer | Technology |
|---|---|
| Language / runtime | TypeScript (ESM, `NodeNext`), Node ≥ 18.17 (tested on Node 22) |
| Package manager | npm (`package-lock.json`), `.npmrc` with `omit=dev`, `engine-strict=true` |
| Backend | [Hono](https://hono.dev) 4.x on `@hono/node-server`, one process; `src/server.ts` → `src/routes.ts` |
| Frontend | Static HTML in `public/` (Tailwind **Play CDN**, `marked` + DOMPurify from jsDelivr, GSAP/Three.js on the landing page). The main app is a single **5,847-line** `app.html`. `app2.html` and `app4.html` are unreferenced older copies |
| Database | PostgreSQL via `pg` (Railway). SQL migrations in `migrations/`, run by `npm run migrate` |
| Material storage | **Local disk**: `uploads/<uuid>.txt`, deleted after `MATERIAL_TTL_MINUTES` (60) |
| Auth | Email+password (bcrypt, cost 12) and Google OAuth. Opaque session token in an `HttpOnly; SameSite=Lax` cookie, stored in `user_sessions` |
| AI provider | Groq via `groq-sdk@0.34`, Chat Completions only, non-streaming |
| Email | Resend (verification and welcome emails) |
| Deployment | Railway (implied by env/comments). No `railway.json`, Dockerfile or Procfile. Netlify mentioned but not configured |
| Tests | `node:test` via `tsx --test`: 1 unit suite (MCQ scoring) + 3 smoke tests. `tests/vision-api.test.ts` is a manual script |

### Request lifecycles

```
Browser (app.html) ──fetch JSON──▶ Hono /api/*
   │                                 ├─ rateLimitMiddleware (in-memory, per "IP" = first X-Forwarded-For entry)
   │                                 ├─ optionalAuthMiddleware (cookie → user_sessions → users)
   │                                 ├─ tokenUsageMiddleware (registered users: weekly/session quota check in Postgres)
   │                                 ├─ guestLimitMiddleware (guests: 5 uses per device_id cookie, in-memory)
   │                                 ├─ aiRateLimitMiddleware + abuseDetectionMiddleware (only on 5 of the 9 AI routes)
   │                                 └─ aiController → materialService.readMaterial(uploads/<id>.txt)
   │                                                 → groqService.<tool>() → Groq chat.completions (one shot)
   │                                                 → updateTokenUsageAfterRequest() → Postgres
   ◀──────────── { answer | questions | cards | … , token_usage, usage_warning }
```

- **AI conversation lifecycle:** the browser keeps the conversation in memory and sends the **whole history** on every
  `/api/chat` call. Messages are also persisted to `chat_messages` / `guest_chat_messages` via separate dashboard and guest
  endpoints. The server has no memory or summarisation of its own.
- **Material lifecycle:** upload → extract text (pdfjs, JSZip, Groq vision OCR) → write `uploads/<uuid>.txt` → referenced
  by `materialId` → deleted after 60 min. "Saved materials" (`user_materials`) stores only **metadata pointing at that file**,
  so a saved material stops working after an hour.
- **Tool lifecycle:** there is no tool-calling loop. Each tool is one prompt template, one Groq call, and JSON or text back.
- **Auth lifecycle:** register (email verification sent, but **not required to log in**) → login creates a 7-day session
  row and sets the cookie → `authMiddleware` looks it up on each request → logout deletes the row. Google OAuth logs into an
  existing account if the email matches.

---

## 2. Existing AI capabilities

| Feature | Exists? | Implementation | Working today? | Keep? | Improve? |
|---|---|---|---|---|---|
| Upload PDF/DOCX/PPTX/TXT → text | Yes | `src/extract/*`, `extractionService` | ✅ (no AI) | Yes | Zip-bomb guard. DOCX/PPTX entity decoding is a no-op (`.replace(/&/g,"&")`). Scanned PDFs get no OCR |
| Image OCR on upload | Yes | `extract/image.ts` → hardcoded Maverick | ❌ model retired. Silently stores the base64 image instead | Yes | Route to vision model (done, §19.1) |
| Image Q&A in chat | Yes | `generateChat` multimodal → hardcoded Maverick | ❌ | Yes | Vision routing + degrade (done) |
| Explain / Forum / Exam / Quiz (text) | Yes | `generateAnswer`: **one generic prompt with only a `TASK: X` label** | ❌ model | Yes | Task-specific prompts (P1). Reframe Forum (see §13) |
| Chat with material context | Yes | `generateChat` | ❌ model | Yes | Streaming, history caps (caps done) |
| MCQ Trainer (generate) | Yes | JSON via prompt + regex extraction | ❌ model | Yes | Strict JSON schema (done). Keep answer key server-side for Exam Mode (P2) |
| MCQ scoring | Yes | deterministic `mcqScoringService` | ✅ | Yes | — |
| Flashcards | Yes | JSON via prompt | ❌ model | Yes | Strict schema (done). Persist + spaced repetition (P2) |
| Dialogue Coach (start/step/hint/feedback) | Yes | 4 JSON prompts + deterministic "How am I doing?" | ❌ model | Yes | Strict schema (done) |
| Session titles | Yes | substring of first message (no AI) | ✅ | Yes | — |
| Token quotas (5h session / weekly / monthly) | Yes | Postgres functions + middleware | ⚠️ works, but **usage is attributed to the wrong request under concurrency** | Yes, it's the billing foundation | Fixed in §19.1. Cost-weighted kredit (P1) |
| Guest trial (5 uses) | Yes | in-memory, keyed on `device_id` cookie | ⚠️ bypass: omit the cookie → unlimited | Yes | Turnstile + IP cap (P1) |
| Function calling / tools | **No** | — | — | — | Chat-agent registry (P2) |
| Structured outputs | **No** | regex JSON extraction | — | — | Done (§19.1) |
| Streaming | **No** | — | — | — | P1 |
| Web search / code execution / MCP | **No** | — | — | — | P3 / optional (§14) |
| RAG / embeddings | **No** | whole material stuffed into the prompt; `clampText` keeps the first and last 100k chars and **silently drops the middle** | ⚠️ | — | Chunked retrieval + citations (P2) |
| Speech / transcription | **No** | — | — | — | Lecture → notes (P2) |

---

## 3. Existing tools: complete inventory

None of these is an LLM function definition. The model receives **only a prompt template**, never a schema. "Compatible
with gpt-oss-120b" means compatible after the migration in §19.1. Every tool below is **preserved**.

| # | Tool | Endpoint | Input | Output | Defined / executes | Model sees | gpt-oss-120b? | Used by UI? | Safety notes | Preserve |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Explain** | `POST /api/explain` | `{materialId \| materialText, prompt?}` | `{answer, token_usage?, usage_warning?}` | `routes.ts` → `aiController.handleAIRequest("explain")` → `groqService.generateAnswer` | system prompt + `TASK: EXPLAIN` + material | ✅ | yes (`TOOL_ROUTES`) | material is untrusted input; size bounded by `MATERIAL_CLAMP` | ✅ |
| 2 | **Quiz (text)** | `POST /api/quiz` | same | same | same, task `quiz` | `TASK: QUIZ` | ✅ | legacy path (composer intercepts and uses #6/#7) | same | ✅ |
| 3 | **Forum** | `POST /api/forum` | same | same | same, task `forum` | `TASK: FORUM` | ✅ | yes | **ghost-writes graded LMS forum posts** (integrity risk, see §13) | ✅ (reposition) |
| 4 | **Exam** | `POST /api/exam` | same | same | same, task `exam` | `TASK: EXAM` | ✅ | yes | frontend default asks for an exam outline and sample questions | ✅ |
| 5 | **Chat** | `POST /api/chat` | `{materialId?, materialText?, messages[{role,content}]}` | `{answer, …}` | `aiController.handleChat` → `groqService.generateChat` | system + material + **client-supplied history** | ✅ text; images → vision model | yes (default) | clients could inject `system` messages and send unlimited history (**fixed**) | ✅ |
| 6 | **MCQ Trainer: start** | `POST /api/quiz/trainer/mcq/start` | `{materialId \| materialText, numQuestions 1–50}` | `{questions[{id,question,options[5],answer,rationale,weaknesses[],studyPlan[]}]}` | `aiController.generateMCQ` → `generateQuizTrainerMCQ` | JSON instructions (now a strict schema) | ✅ | yes (quiz composer) | answer key is sent to the browser before the student answers | ✅ |
| 7 | **MCQ Trainer: score** | `POST /api/quiz/trainer/mcq/score` | `{questions[], userAnswers{}}` | `{analysis}` | `mcqScoringService` (no AI) | — | n/a | yes | unauthenticated but costs nothing | ✅ |
| 8 | **Flashcards** | `POST /api/flashcards` | `{materialId \| materialText, numCards 1–50}` | `{cards[{id,front,back}]}` | `aiController.generateFlashcards` → `generateFlashcards` | JSON instructions (now a strict schema) | ✅ | yes | no aiRateLimit/abuse middleware | ✅ |
| 9 | **Dialogue: start** | `POST /api/dialogue/start` | `{materialId \| materialText}` | `{sessionId, language, intro, topics[3], firstCoachPrompt}` | `startDialogue` → `dialogueStart` | JSON (strict) | ✅ | yes | same | ✅ |
| 10 | **Dialogue: step** | `POST /api/dialogue/step` | `{material…, topics[], currentTopicIndex, userMessage, lastCoachQuestion?, language?}` | `{addressed, moveToNext, coachMessage, nextCoachQuestion?, isComplete?}` | `stepDialogue` → `dialogueStep` (+ deterministic "How am I doing?") | JSON (strict) | ✅ | yes | same | ✅ |
| 11 | **Dialogue: hint** | `POST /api/dialogue/hint` | `{material…, currentTopicTitle, language?}` | `{hint}` | `hintDialogue` → `dialogueHint` | JSON (strict) | ✅ | yes | same | ✅ |
| 12 | **Dialogue: feedback** | `POST /api/dialogue/feedback` | `{material…, topics[], history[], language?}` | `{feedback, strengths[], improvements[]}` | `feedbackDialogue` → `dialogueFeedback` | JSON (strict) | ✅ | yes | same | ✅ |
| 13 | **Upload / extract (+ vision OCR)** | `POST /api/upload` | multipart `file`(s), `append`, `mergeTo` | `{materialId, files, extractedFiles…}` | `uploadController` → `extractionService` → `extract/*` | OCR prompt + image | ✅ via vision model | yes | DOCX/PPTX decompressed size unbounded (zip bomb) | ✅ |
| 14 | Material get / remove-file / delete | `GET/POST/DELETE /api/material/:id…` | UUID | info | `materialController` (no AI) | — | n/a | yes | capability URL (UUIDv4), no auth | ✅ |
| 15 | Chat-session title (user / guest) | `…/generate-title` | — | `{title}` | substring, no AI | — | n/a | yes | — | ✅ |

The regression suite added in §19.1 (`tests/ai/studyTools.test.ts`) calls **every AI endpoint (#1–#13)** with a mocked
Groq client. It asserts that the route is registered, that bad arguments get a 4xx, that a valid call returns the expected
shape, that a Groq failure is handled, that the fallback model is used on retryable errors, and that usage is attributed
to the correct request.

---

## 4. Current Groq model

| | |
|---|---|
| Configured default | `GROQ_MODEL=meta-llama/llama-4-maverick-17b-128e-instruct` (`src/config/env.ts`, `.env.example`) |
| Hardcoded copies | `src/services/groqService.ts:280` (vision path), `src/extract/image.ts:10` (OCR) |
| Status on Groq | **Deprecated 20 Feb 2026, shut down 9 Mar 2026.** Groq's recommended replacement is `openai/gpt-oss-120b` ([Groq deprecations](https://console.groq.com/docs/deprecations), [ha-llmvision issue](https://github.com/valentinfrlch/ha-llmvision/issues/617)) |

### Groq's 2026 model churn (a strategic risk in itself)

| Model | Shutdown | Groq's suggested replacement |
|---|---|---|
| `meta-llama/llama-4-maverick-17b-128e-instruct` | 9 Mar 2026 | `openai/gpt-oss-120b` |
| `moonshotai/kimi-k2-instruct-0905` | 15 Apr 2026 | `openai/gpt-oss-120b` ([Groq community](https://community.groq.com/t/kimi-k2-deprecation-whats-the-point-of-building-on-groq-if-models-keep-disappearing/1248)) |
| `meta-llama/llama-4-scout-17b-16e-instruct`, `qwen/qwen3-32b` | 17 Jul 2026 | `openai/gpt-oss-120b` / Qwen 27B |
| `llama-3.1-8b-instant`, `llama-3.3-70b-versatile` | 16 Aug 2026 (free and dev tiers) | — |
| `groq/compound`, `groq/compound-mini` | 21 Sep 2026 | none listed |

**Production chat models remaining (Oct 2026):** `openai/gpt-oss-120b` and `openai/gpt-oss-20b`.
**Preview:** `qwen/qwen3.8-27b` (the only vision model) plus safety/guard models. **Speech:** `whisper-large-v3`,
`whisper-large-v3-turbo` ([Groq models](https://console.groq.com/docs/models), [glamdringresearch snapshot Sep 2026](https://www.glamdringresearch.com/post/groq-api-pricing),
[usagepricing](https://www.usagepricing.com/blueprint/activity/groq-2026-07-21-models-tools-pulled)).

---

## 5. Deprecated / broken components

| Component | Problem | Severity |
|---|---|---|
| All AI calls | Retired model ID | **P0, total outage** |
| Vision OCR | Retired model, error swallowed. Every image is stored as ~1.3× its size in base64 text | P0 |
| Text tools with image materials | Base64 data inlined into *text* prompts (up to 200k chars of base64) → context overflow or a huge token bill | P0 |
| `max_tokens` budgets (500–1500) | gpt-oss is a reasoning model. Reasoning tokens use up the budget, so output can come back **truncated or empty** | P0 for migration |
| Token accounting | `groqService.lastTokenUsage` is a **singleton field**. Concurrent requests overwrite it, so users are billed for each other's calls, and a failed call bills the previous call's usage | P0 (billing integrity) |
| Error surface | Groq errors are returned to the student as a 200 "answer" containing raw provider messages | P0 |
| Timeout | `withTimeout` rejects but **doesn't abort** the HTTP call, and the SDK's own retries stack on top (up to ~3×45s) | P0 |
| Deployment | `.npmrc omit=dev` + `"start": "tsx …"` (tsx is a devDependency) → clean install has no `tsx` → **process fails to start** | P0 |
| `aiRateLimit` | `recordAITokenUsage` is **never called**, so hourly limits never trigger. The burst check is also wrong (it only looks at the timestamp of the last request) | P1 |
| `abuseDetection` | Inspects `message`/`materialText`/`question`, but the UI sends `messages`/`prompt`/`materialId`, so the check is **effectively inert**. (A suspected ReDoS in its regex was benchmarked and is *not* exploitable in V8: 2 ms at 20k chars) | P1 |
| "Saved materials" | Metadata points at a file that the TTL deletes after 60 min | P1 (product) |
| Dead code | `public/app2.html`, `public/app4.html` (unreferenced), `dev:legacy`/`start:legacy`/`test:legacy` scripts referencing a missing `backup/legacy/`, `PROJECT-STRUCTURE.md` claims legacy files exist, `injectUsageStatsMiddleware` unused, `strictAuthMiddleware` unused, duplicate `Dialogue*` interfaces | P3 (report only, nothing deleted) |
| `migrations/AUTH_ANALYTICS_QUERIES.sql` | Ends in `.sql`, so the migration runner **executes it as a migration**. It is SELECT-only, so harmless, but it's an accident waiting to happen | P3 |

---

## 6. Dependency problems

| Package | Was | Latest | Issue | Action |
|---|---|---|---|---|
| `groq-sdk` | 0.34.0 (caret on 0.x pins to 0.34) | 1.6.0 | No types for `reasoning_effort`, strict `json_schema`, `browser_search`/`code_interpreter`. 1.x keeps the same `chat.completions.create` surface | **Upgraded** |
| `hono` | 4.10.4 | 4.13.x | 8 advisories incl. serve-static path issues, CORS reflection (we don't use CORS), JSX XSS (not used) | **Patched** (in range) |
| `@hono/node-server` | 1.19.6 | 1.19.17 / 2.x | serve-static auth bypass via encoded or repeated slashes | **Patched** to latest 1.x |
| `form-data`, `uuid` (transitive) | — | — | CRLF injection / bounds check | `npm audit fix` (non-breaking) |
| `pdfjs-dist` | 5.4 | 6.4 | serverless font/CMap CDN pinned to **4.4.168** (version mismatch) | P2: upgrade with extraction tests |
| `tsx` | devDependency | — | needed at runtime by `npm start` | **Moved to dependencies** |
| Frontend CDNs | Tailwind **Play CDN** (not for production), **unpinned** `marked`, no SRI | — | performance on low-end Android; supply-chain XSS | P1 |

---

## 7. Security problems

Ranked by impact for a student-facing, pay-per-token product. ✅ means fixed on this branch.

| # | Issue | Impact | Status |
|---|---|---|---|
| S1 | **Guest-limit bypass**: the limit is keyed on a `device_id` cookie, and a client that omits it gets a fresh 5 uses each time. Combined with S2, this means **unlimited anonymous Groq spend** and the ability to exhaust the org-wide TPM for everyone | Denial of wallet / DoS | P1 (needs a product decision: Turnstile / login wall) |
| S2 | Client IP = **first** `X-Forwarded-For` entry, which the client controls. Every per-IP limit can be bypassed | Limit bypass | P1 (needs proxy-hop config verified on Railway) |
| S3 | Token usage attributed across concurrent users; failed calls billed | Billing integrity | ✅ |
| S4 | Client-supplied `system` messages and unbounded chat history passed to the model | Prompt injection, cost amplification | ✅ (system dropped; 30 msgs / 8k chars each / 60k total) |
| S5 | OAuth callback **logs session tokens and cookies** in plaintext | Session hijack via logs | ✅ |
| S6 | OAuth has no `state` parameter | Login CSRF | P1 |
| S7 | Password login doesn't require a verified email, and Google sign-in attaches to any existing account with that email → **account pre-hijacking** | Account takeover | P1 |
| S8 | `POST /dashboard/chat/sessions/:id/messages` checks that the session exists but **not who owns it** | IDOR (write into others' chats) | ✅ |
| S9 | `POST /api/admin/cleanup` unauthenticated | Low (deletes expired files only) | ✅ (admin only) |
| S10 | Vulnerable `hono` / `@hono/node-server` | serve-static bypass | ✅ |
| S11 | HTML in user `name` interpolated unescaped into emails sent from our domain | Phishing | P1 |
| S12 | No CSP or security headers. CDN scripts unpinned and without SRI | XSS via supply chain | P1 |
| S13 | DOCX/PPTX zip bombs (JSZip, no decompressed-size cap) | Memory DoS | P1 |
| S14 | No JSON body size limit on AI routes; `materialText` accepted up to `MATERIAL_CLAMP` (200k chars ≈ 57k tokens) | Cost amplification | P1 (body limit) |
| S15 | Session tokens stored unhashed; DB TLS `rejectUnauthorized:false` | Defence in depth | P2 |
| S16 | Account sharing on paid plans (unlimited concurrent sessions) | Revenue leakage | P1 with payments |
| S17 | Prompt injection via uploaded documents | Low today (the model can't take actions). **Must be treated as untrusted once tools exist** | Design rule for P2 |
| — | Arbitrary code execution / SSRF | **None exists.** If `code_interpreter` is added it runs in Groq's sandbox, not ours. Never add local exec. Any future "import from URL" needs an SSRF guard | — |
| — | API key exposure | `GROQ_API_KEY` is server-side only, never sent to the browser. `.env` is gitignored. ✅ | — |

---

## 8. Market research findings (Indonesia, 2026)

**Students already use AI heavily.** 86% of 15–21-year-old students use AI for assignments at least monthly, and 9.4% use
it for ~90% of their work ([Tirto × Jakpat 2024](https://nasional.tvrinews.com/berita/ttc1npe-menkominfo-87-persen-pelajar-gunakan-ai-untuk-kerjakan-tugas)).
95% of Indonesian university respondents use GenAI for learning, the highest of 15 countries surveyed
([GoodStats](https://data.goodstats.id/statistic/95-mahasiswa-ri-gunakan-ai-dalam-proses-pembelajaran-FIm7A)). Over 90% of
PTKIN students use ChatGPT 4–6×/week ([BRIN 2025 via UNESA](https://pendidikan-fisika.fmipa.unesa.ac.id/post/fenomena-penggunaan-chatgpt-di-kalangan-mahasiswa-antara-peluang-dan-tantangan-dalam-dunia-akademik)).
Market education is done. **Differentiation is the problem.**

### 8.1 What students already get for free
- ChatGPT Free, Gemini, Copilot, Perplexity free tiers.
- **NotebookLM (free):** upload sources → grounded Q&A, quizzes, flashcards, audio overviews. This is **ILMATRIX's core feature set, for free**.
- **Google AI Plus free for 12 months** for verified Indonesian university students 18+ (claim window 11 Aug–31 Dec 2026,
  SheerID, **requires a valid payment method**) ([CNN Indonesia](https://www.cnnindonesia.com/teknologi/20260827135643-185-1396949/google-ai-plus-gratis-1-tahun-khusus-mahasiswa-ini-cara-klaimnya), [IDN Times](https://www.idntimes.com/tech/trend/mahasiswa-dapat-google-ai-plus-gratis-1-tahun-c1c2-01-cy47d-2zcp9b)).
  **High-school students (<18) are not eligible.**
- Free tiers of Brainly, Gauth, Roboguru and Ruangguru AiRIS (Basic).

### 8.2 What students currently pay for
| Product | Price (IDR) | Source |
|---|---|---|
| ChatGPT Go / Plus | Rp75.000 / Rp349.000 per month (incl. PPN) | [Kompas Jul 2026](https://tekno.kompas.com/read/2026/07/28/13350077/harga-paket-langganan-chatgpt-di-indonesia-per-juli-2026) |
| ChatGPT Go via Telkomsel bundle | from Rp50.000 (≤2 months, promo ended Apr/May 2026) | [Telkomsel](https://www.telkomsel.com/about-us/news/telkomsel-openai-hadirkan-promo-bundel-chatgpt-go-yang-lebih-terjangkau-mulai-rp50000) |
| Perplexity Pro, Telkomsel student bundle | Rp35.000–100.000 | [Kompas May 2026](https://tekno.kompas.com/read/2026/05/27/16280007/telkomsel-punya-paket-chatgpt-dan-perplexity-untuk-pelajar-mahasiswa-ini?page=all) |
| Gauth Plus | Rp29rb/mo · Rp89rb/3 mo · Rp199rb/yr (App Store ID) | [App Store](https://apps.apple.com/id/app/gauth-ai-study-companion/id1542571008) |
| Brainly Plus | ~Rp29rb/mo · Rp219–249rb/yr (several SKUs) | [App Store](https://apps.apple.com/id/app/brainly-ahlinya-tugas/id745089947?l=id&platform=ipad) |
| Roboguru Premium (Ruangguru) | Rp49rb/mo promo · Rp249rb/yr | [Ruangguru](https://www.ruangguru.com/blog/paket-ruangbelajar-roboguru-plus-premium) |
| Zenius | Rp175rb/mo · Rp450rb/12 mo | [Zenius](https://www.zenius.net/blog/langganan/) |
| Pahamify | Rp140rb/mo; live class Rp1,73 jt | [Tokopedia/Pahamify](https://www.tokopedia.com/belajar/pahamify/) |
| Spotify Premium Student (spend anchor) | Rp29.900–39.900/mo | [JournalArta](https://journalarta.com/news/2026/09/29/harga-spotify-premium-terbaru-30-september-2026/?all=1) |

The pattern is clear: **~Rp29k/month is the proven student price point** for AI homework apps. Exam-prep (bimbel)
commands far more (Rp450k–Rp1,7 jt), but it is mostly paid by parents.

### 8.3 What they still hate
- Answers without understanding, and a nagging fear of being caught. Campuses use Turnitin AI indicators, and **70.7%** of
  students have never been given AI-ethics guidance ([UGM GenAI guide 2024](https://lib.ugm.ac.id/wp-content/uploads/sites/44/2025/04/panduan_penggunaan_generative_ai_di_perguruan_tinggi.pdf), [journal summary](https://www.journal.unpas.ac.id/index.php/pendas/article/download/38607/20723/143185)).
- Generic answers that don't match *their lecturer's* slides or exam style.
- Free-tier caps hitting during exam week. Credit-card-only payment (Google's student offer requires one).
- No continuity: every chat starts from zero, and nothing tracks what they still don't know.

### 8.4 What they would realistically pay for
Exam outcomes at exam time: "UTS Kalkulus in 5 days, here are 6 slide decks, tell me what I don't know and drill me".
Paid **per exam period** (weekly or semester passes) through **QRIS / e-wallet**, priced around snacks and streaming.

### 8.5 What would make ILMATRIX meaningfully different
1. **Exam Mode on your own materials**: timed mock UTS/UAS, server-side scoring, and a **persistent weak-topic map**
   across the semester. NotebookLM quizzes don't track mastery or plan toward a date.
2. **Learning-first by design**: hint ladder, "cek jawabanku" (find the first error in my working), explanation-first.
   This lines up with the 2024 national GenAI guideline and the Mar 2026 seven-minister SKB on digital/AI learning, so
   lecturers can *recommend* it rather than ban it.
3. **Indonesian-first, local payment, exam-calendar pricing** (Rp9.900 pass, Rp99.000 semester).

---

## 9. Competitor comparison

| | NotebookLM | Gemini (AI Plus, free 12 mo for mhs) | ChatGPT Go | Gauth / Brainly | Ruangguru / Zenius | **ILMATRIX (proposed)** |
|---|---|---|---|---|---|---|
| Price | Free | Free (mhs 18+, card) | Rp75k/mo | Rp29k/mo | Rp175k–450k+ | **Rp9.9k/week, Rp99k/semester** |
| Grounded in *my* materials | ✅ strong | ✅ | partial | ❌ | ❌ (their content) | ✅ |
| Quizzes / flashcards | ✅ | ✅ | ad hoc | ❌ | ✅ (their bank) | ✅ |
| Persistent mastery / weak-topic tracking toward an exam date | ❌ | partial (study notebooks) | ❌ | ❌ | ✅ (their curriculum) | **✅ (core)** |
| Timed mock exam from *my* slides | ❌ | ❌ | ❌ | ❌ | ✅ (their bank) | **✅ (core)** |
| Learning-first / anti-answer-dump | ❌ | partial (Guided Learning) | partial (study mode) | ❌ (answer engine) | ✅ | **✅ default** |
| Local payment (QRIS) | n/a | card | app store / GoPay | app store | ✅ | **✅** |
| Indonesian UX | ✅ | ✅ | ✅ | ✅ | ✅ native | ✅ (needs work) |

Honest read: ILMATRIX **cannot win on chat quality, model quality, or breadth**. It can win a narrow job (pass this
course's exam using these slides) if Exam Mode and persistence get built. Without them, the paid product isn't viable.

---

## 10. Target customer

**Primary (beachhead):** Indonesian **S1 students in semesters 1–4**, in courses that run slide- or module-based exams
(STEM foundations, economics/accounting, health sciences). Specifically, *the week before UTS/UAS*.

Why this segment rather than the alternatives:
- **Fits the existing product**, which is material-upload-first and whose system prompt already targets university students.
- **18+, so no parental-consent obligations.** PP Tunas (PP 17/2025, in force 28 Mar 2026, compliance deadline
  27 Mar 2027) requires age verification and parental consent for users under 18
  ([Bisnis](https://teknologi.bisnis.com/read/20260505/101/1971394/10-kewajiban-platform-dalam-pp-tunas-yang-perlu-diketahui-pse)).
- The exam calendar (UTS Oct/Mar, UAS Dec–Jan/Jun) creates natural purchase moments.

**Secondary (phase 2, after PP Tunas consent flow):** SMA kelas 12 preparing for **TKA** (4.2M registrants in 2026, exams
26 Oct–8 Nov) and UTBK-SNBT ([Gebrak](https://www.gebrak.id/?p=57121)). This segment is large and not eligible for
Google's student offer, but it needs curriculum-aligned question quality and a parent-facing consent flow.

**Not now:** "everyone", teachers/lecturers (B2B2C later), skripsi writers (pulls toward ghost-writing).

## 11. Main selling point

> **"Simulasi UTS/UAS dari slide dosenmu sendiri: tahu persis bab mana yang belum kamu kuasai, sebelum ujian."**
> (Mock exams generated from your own lecturer's slides, with a weak-topic map.)

## 12. Product positioning

- **Core value proposition (one sentence):** *ILMATRIX turns your own lecture materials into an exam coach that finds and
  fixes your weak topics before UTS/UAS. It's learning-first, not answer-dumping, for Rp99k a semester.*
- **Primary job to be done:** "When I have an exam in a few days and a pile of slides, help me know what I don't know and
  practise until I do."
- **Why pay instead of free ChatGPT/Gemini?** Free tools *answer questions*. ILMATRIX *runs your exam prep*: it remembers
  your mistakes across sessions, simulates the exam format from your materials, and tells you what to study next, at a
  price that's only paid when it matters (exam weeks).
- **Secondary selling points (max 5):**
  1. Tutor mode that guides rather than gives: hint ladder, *cek jawabanku*. Safe to use under campus GenAI guidelines.
  2. Everything grounded in *your* materials, with slide/page references.
  3. Flashcards with spaced repetition that last the whole semester.
  4. Lecture recording → structured notes (P2, paid).
  5. Pay with QRIS / e-wallet, no credit card: Rp9.900 for exam week.

---

## 13. Recommended features (and ones I'd push back on)

| Area | Recommendation |
|---|---|
| **Exam Mode** (timed mock, server-side answer key, scoring, weak-topic detection, retry wrong topics) | **Build (P2-1). This is the product.** Extend `mcqScoringService`. Add `quiz_attempts` and `topic_mastery` tables |
| Persistence (materials, attempts, cards) | **Prerequisite (P1-1).** Today everything evaporates after 60 min |
| Study plan to exam date per course ("mata kuliah" workspace) | Build (P2-2), lightweight |
| Spaced-repetition flashcards | Build (P2-3) |
| Learning mode (hint ladder, don't-give-answer, solution verification) | Build (P2-4). Cheap prompt + UI work and a marketing differentiator |
| **Forum tool** | **Push back.** It ghost-writes graded forum posts, which contradicts the positioning. Keep the tool (as required) but reposition it to *outline / critique my draft* (needs approval) |
| Socratic Dialogue Coach | Keep. It's a good differentiator. Make it reachable from Exam Mode ("discuss the topics you got wrong") |
| Lecture audio → notes (Whisper turbo, $0.04/h) | Build (P2-5), paid. High value for mahasiswa at ~Rp1.2k/lecture |
| Photo-of-problem tutor (vision) | Build (P2-8) as a **Socratic** flow, capped, flagged (Preview model) |
| Research agent / citation generator / web research | **Not core.** It pulls toward essay ghost-writing. At most "verify a fact" in paid tiers (P3) |
| Coding agent (`code_interpreter`) | Optional (P3) for Informatika/Statistika |
| Generic "chat with any PDF" | Already exists. Don't market it, because it's commoditised |

## 14. Groq architecture recommendation

**Today there is nothing to preserve at the function-calling layer.** The product tools are deterministic, UI-driven
workflows: the student picks a tool and the backend runs a prompt. **Turning them into LLM-callable functions would add
latency, cost and nondeterminism with no student benefit**, so they stay as typed service methods.

Recommended layering (implemented incrementally; ✅ = this branch):

```
Controllers (unchanged REST contracts)
   │
GroqService ── study-tool methods (explain/quiz/forum/exam/chat/mcq/flashcards/dialogue×4/OCR)   ✅ preserved
   │
AI provider layer (single place for Groq):                                                     ✅
   • model routing: GROQ_MODEL (gpt-oss-120b) · GROQ_FALLBACK_MODEL (gpt-oss-20b) · GROQ_VISION_MODEL (qwen3.8-27b)
   • reasoning_effort per tool, max_completion_tokens headroom, hidden reasoning
   • structured outputs: strict json_schema → json_object → prompt-only fallback chain
   • fallback on 429/5xx/timeout/decommissioned model · SDK timeout + bounded retries
   • per-request usage capture (AsyncLocalStorage) → quotas/billing
   │
Tool registry (P2, for Chat agent mode only)
   ├── App tools (local, JSON-schema validated): search_my_materials, make_quiz, make_flashcards, explain_mistake
   ├── Groq built-in tools: browser_search, code_interpreter (executed on Groq; paid tier; NOT combinable with strict JSON)
   └── MCP tools: Groq Remote MCP (beta, Responses API — not in groq-sdk; use fetch/OpenAI-compatible client) — later
```

Key constraints found in research: built-in tools exist for gpt-oss-120b, but **Visit Website and Wolfram Alpha are not
available** for gpt-oss, and **browser search is incompatible with structured outputs**
([Groq built-in tools](https://console.groq.com/docs/tool-use/built-in-tools), [browser search](https://console.groq.com/docs/tool-use/built-in-tools/browser-search)).
Built-in tool **prices are currently unpublished** (the old page listing $5–8 per 1k searches and $0.18/h code execution
was removed in Aug 2026, [usagepricing](https://www.usagepricing.com/blueprint/groq)). Remote MCP is **beta**
([Groq remote MCP](https://console.groq.com/docs/tool-use/remote-mcp)).

### Groq feature evaluation

| Feature | User value | Technical complexity | API cost | Recommended? |
|---|---|---:|---:|---|
| Structured outputs (strict JSON schema) | High: no more broken quizzes | Low | none | **Yes, done** |
| Reasoning-effort control | High: quality vs speed per tool | Low | reasoning billed as output | **Yes, done** |
| Model fallback (120b → 20b) | High: uptime during 429s | Low | 20b is half price | **Yes, done** |
| Vision (qwen3.8-27b, Preview) | High: photo of a problem or handwritten notes | Low | ≈ Rp144/photo | **Yes, flagged, capped** |
| Streaming (SSE) | High perceived speed for long explanations | Medium (frontend) | none | **Yes, P1** |
| Prompt caching (automatic, 50% off cached input on gpt-oss) | Indirect: cheaper repeat calls on the same material | Low (stable prompt prefix) | saves money | **Yes, P1** ([Groq prompt caching](https://console.groq.com/docs/prompt-caching)) |
| Speech-to-text (whisper-large-v3-turbo) | High for lecture recordings | Medium | $0.04/audio hour | **Yes, P2 paid** |
| Local function calling (chat agent) | Medium | Medium | low | P2 |
| `browser_search` | Low–medium (not exam-prep core) | Low | unpublished (≈$5–8/1k historically) | P3, paid only |
| `code_interpreter` | Medium for CS/stats | Low | unpublished (≈$0.18/h historically) | P3 optional |
| Remote MCP | Low for students today | Medium (beta, Responses API) | tokens | **No** (design for it, don't build) |
| Parallel tool calls | Low | — | — | No |
| Batch API (50% off, async) | Low (offline question banks) | Low | saves money | Later |

## 15. Model recommendation

```
OLD MODEL      meta-llama/llama-4-maverick-17b-128e-instruct   (retired 2026-03-09)
   ↓
RECOMMENDED    text:      openai/gpt-oss-120b      (production)
               fallback:  openai/gpt-oss-20b       (production, separate rate-limit pool)
               vision:    qwen/qwen3.8-27b         (PREVIEW — feature-flagged, degrades gracefully)
               speech:    whisper-large-v3-turbo   (P2)
   ↓
WHY            • Groq's own designated replacement; one of only two production chat models left on Groq.
               • Indonesian MMMLU 82.8 (medium) / 84.3 (high reasoning), above its own multilingual average
                 ([gpt-oss model card](https://arxiv.org/pdf/2508.10925)) — adequate for Bahasa Indonesia tutoring.
               • Strict JSON-schema outputs (constrained decoding) → reliable quiz/flashcard/dialogue JSON.
               • $0.15 in / $0.60 out per 1M; cached input $0.075; ~500 tok/s; 131k context (same as before).
               • Built-in browser_search / code_interpreter available if ever needed.
               • qwen3.8-27b is NOT chosen as primary: Preview (can be pulled at short notice), $0.80/$4.00 per 1M
                 (≈5–7× output cost) — but it is the only Groq model that accepts images.
   ↓
COMPATIBILITY  1. Text-only: image parts are rejected ("content must be a string") → images routed to vision model,
ISSUES            ≤3 images/request; base64 blobs stripped from text-only prompts.
               2. Reasoning model: reasoning tokens consume the completion budget and are billed → max_completion_tokens
                  with headroom; reasoning_effort per tool (low for JSON tools); include_reasoning:false.
               3. Prompt-only JSON was fragile → strict json_schema (root must be an object; all fields required;
                  additionalProperties:false) with automatic fallback to json_object then prompt-only.
               4. Rate limits: free tier ≈ 8k TPM / 200k TPD for 120b — unusable for production; Developer tier
                  (~250–300k TPM, 1k RPM) required ([rate-limit trackers](https://inferenceapis.com/reference/rate-limits)).
               5. groq-sdk 0.34 lacked typings → upgraded to 1.6.0.
   ↓
MIGRATION      env-driven model IDs (no hardcoded IDs anywhere) · reasoning-aware params · vision routing + degrade ·
CHANGES        structured outputs + fallback chain · fallback model on retryable errors · SDK timeout/retries ·
               per-request usage capture · friendly error messages · base64 stripping · `npm run groq:check`.
   ↓
TESTS          tests/ai/groqService.test.ts (params, schemas, fallback, vision routing, usage isolation, errors) ·
REQUIRED       tests/ai/studyTools.test.ts (every AI endpoint: registered, validates args, returns shape, handles
               failure, records usage) · `npm run groq:check` against the live API before deploy (not runnable here).
```

---

## 16. Pricing recommendation

### Don't convert the dollar price
"$5 → Rp70k" isn't just the wrong method. At today's rate (JISDOR **Rp17.917/USD**, 6 Oct 2026,
[JournalArta](https://journalarta.com/news/2026/10/06/rupiah-hari-ini-6-oktober-2026/)) it would be Rp89.6k, which is
more than ChatGPT Go. Price instead against **student anchors** (Rp29k apps, Rp30–40k Spotify Student, Rp75k ChatGPT Go)
and **when** students feel the pain (exam weeks).

### Unit: cost-weighted *kredit*
Charge vision, search and audio as token-equivalents inside the existing quota system, so every plan has a **hard COGS
ceiling**.

- **1 kredit ≈ Rp4 of AI cost** at gpt-oss-120b prices and Rp18.000/USD.
- Typical actions: grounded chat/explain ≈ **9 kredit** (~8k in / 1.5k out ≈ Rp35) · 10-question quiz ≈ **17** (Rp68) ·
  15 flashcards ≈ **12** (Rp46) · dialogue step ≈ **6** · photo solve (vision) ≈ **36** (Rp144) · web-searched answer ≈ **40** ·
  1 hour of lecture audio → notes ≈ **200** (≈Rp800).

### Pricing models considered

| Model | Description | Verdict |
|---|---|---|
| A. Monthly SaaS | Free + Rp29k/mo | Familiar, but students resist yet another subscription, and usage is spiky |
| B. Exam-cycle passes | **Rp9.900 / 7 days**, **Rp99.000 / semester** | **Recommended as the hero.** Matches when pain peaks. Rp99k stays under the **Rp100k QRIS 0% MDR** threshold (BI, from 1 Oct 2026, [Viva](https://www.viva.co.id/bisnis/1922115-qris-makin-murah-mulai-oktober-2026-mdr-0-persen-berlaku-untuk-transaksi-hingga-rp100-ribu)) |
| C. Pure credits | Top up Rp5k–20k, pay per use | Good as an add-on, too fiddly as the only model |
| D. Campus / class licence | Lecturer buys for a class, ~Rp10–15k/student/semester | Later (P3). Needs teacher features |

### Recommended plan table

| Plan | Price | Allowance | Max AI COGS | Gross margin (typical / worst) | Abuse risk |
|---|---|---|---|---|---|
| **Gratis** (verified email) | Rp0 | 150 kredit/week (~16 grounded answers), 3 photos/week, no web/audio | Rp2.6k/mo (exp. ~Rp0.4k) | n/a | **High** until S1/S2 are fixed; one account per verified email |
| **Pass 7 Hari** | **Rp9.900** | 1.000 kredit for 7 days | Rp4.0k | **82% / 58%** | Low (prepaid, short) |
| **Semester** (hero) | **Rp99.000** (≈Rp16.5k/mo) | 700 kredit/week for 26 weeks | Rp12.1k/mo | **80% / 26%** | Medium: account sharing → cap 2 concurrent sessions |
| **Bulanan** | Rp29.000 | 900 kredit/week | Rp15.6k/mo | **80% / 45%** | Medium (same) |
| Top-up | Rp5.000 | 600 kredit | Rp2.4k | ≥50% | Low |

Assumptions: payment fees ~0–2% (QRIS 0% under Rp100k via the gateway's MDR; e-wallets ~1.5–2%; **avoid VA for small
tickets**, since Rp4k flat is 40% of a Rp9.9k pass). PPh final UMKM 0.5% (PP 55/2022, below Rp4.8 bn revenue; confirm with
an accountant). "Typical" means students use ~25–40% of their allowance. Sell **on the web** (QRIS), not through Google
Play billing (15% fee).

## 17. Unit economics

**Fixed monthly costs (launch, <5k MAU):** Railway app + Postgres ≈ Rp0.7–1.3 jt
([Railway pricing 2026](https://livemy.app/blog/railway-pricing)), object storage (R2 free tier), Resend free → $20,
domain and misc. **≈ Rp1.5 jt/month.** This excludes salaries and marketing.

**Contribution per payer per month (typical):** Semester ≈ Rp13.2k · Bulanan ≈ Rp23.1k · Pass ≈ Rp8.2k per pass (assume
1.5/month) → blended (50/30/20 mix) **≈ Rp16k**.

**Free-user cost:** ≈ Rp400 per free MAU per month (most MAU are light users). This is the number to watch.

| Conversion (payers / MAU) | Break-even MAU | Paying users | Comment |
|---|---:|---:|---|
| covering fixed cost only | — | **~94** | ignores free users |
| 3% | ~16,300 | ~490 | free tier too generous at this conversion |
| 5% | ~3,600 | ~180 | realistic target with exam-week passes |
| 8% | ~1,650 | ~130 | needs strong Exam Mode |

Formula: `MAU = F / (c·16,000 − (1−c)·400)`. With fixed costs F = Rp1.5 jt, freemium only works above roughly **2.4%
conversion**. **Conclusion:** Groq COGS for a typical paying student is ≈ **Rp3–6k/month (~$0.2–0.3)**. The economics are
defensible *if* the free tier stays capped, guests can't burn tokens, and Exam Mode makes conversion ≥5%. If those three
don't happen, the economics fail regardless of model choice.

---

## 18. Roadmap

Effort is for one developer, in days.

### P0: must fix (currently breaks the app) — **done on this branch**

| ID | Problem | Solution | Files | Complexity | Effort | User impact | Business impact |
|---|---|---|---|---|---|---|---|
| P0-1 | Retired model → all AI fails | env-driven gpt-oss-120b + fallback 20b | `config/env.ts`, `services/groqService.ts`, `.env.example` | S | 0.5 | App works again | Product exists |
| P0-2 | Reasoning budget can truncate or empty answers | `max_completion_tokens` headroom, `reasoning_effort`, hidden reasoning | `groqService.ts` | S | 0.25 | Complete answers | — |
| P0-3 | Vision OCR and image chat broken | `GROQ_VISION_MODEL`, ≤3 images, graceful degrade | `groqService.ts`, `extract/image.ts` | S | 0.5 | Photos work again | — |
| P0-4 | Base64 inlined into text prompts | strip and replace with placeholders for text-only calls | `groqService.ts` | S | 0.25 | No context errors | Avoids token blow-ups |
| P0-5 | Usage billed to wrong user / failed calls billed | per-request usage via AsyncLocalStorage | `groqService.ts`, `aiController.ts` | S | 0.5 | Fair quotas | Billing integrity |
| P0-6 | Fresh deploy can't start | `tsx` → dependencies | `package.json` | XS | 0.1 | — | Deployable |
| P0-7 | Old SDK, vulnerable hono | upgrade groq-sdk 1.6, patch hono/node-server, audit fix | `package*.json` | S | 0.25 | — | Security |
| P0-8 | Raw errors, no fallback, timeouts don't abort | error mapping, fallback, SDK timeout/retries | `groqService.ts` | S | 0.5 | Friendly errors | Uptime |
| P0-9 | No AI or tool tests | mocked-Groq unit + endpoint regression suites, live check script | `tests/ai/*`, `scripts/groq-live-check.ts` | M | 1 | — | Safe migration |
| P0-10 | Quick security wins | system-role filter + history caps, IDOR fix, no token logging, admin-only cleanup | `aiController.ts`, `chatHistoryService.ts`, `oauthController.ts`, `routes.ts` | S | 0.5 | — | Security |

### P1: must have before launch (needs approval)

| ID | Problem → Solution | Files | Cx | Days | User impact | Business impact |
|---|---|---|---|---|---|---|
| P1-1 | Materials vanish after 60 min → store extracted text in Postgres (or R2) per user, keep TTL for guests | `materialService`, new migration, dashboard | M/L | 3–5 | Library that persists | Prerequisite for everything paid |
| P1-2 | Guest denial-of-wallet → Cloudflare Turnstile + trusted-proxy IP (`TRUST_PROXY_HOPS`) + per-IP daily cap + guests on gpt-oss-20b | `guestLimit`, `security.ts`, frontend | M | 1–2 | — | Caps free spend |
| P1-3 | AI rate limiter inert/buggy → record usage, sliding-window burst, sane limits | `aiRateLimit.ts`, `aiController.ts` | S | 0.5 | — | Abuse control |
| P1-4 | Remaining security: OAuth `state`, verified-email login + safe Google linking, email HTML escape, CSP/headers, SRI-pinned CDNs, JSON body limit, zip-bomb cap, hashed session tokens | auth/oauth/email/server/extract | M | 2–3 | — | Trust |
| P1-5 | No payments → Midtrans or Xendit (QRIS + e-wallets), plans/passes/entitlements → quotas | new `billing*`, migration, UI | L | 4–6 | Can buy | Revenue |
| P1-6 | Tokens ≠ cost → cost-weighted kredit from prompt/completion tokens + vision/search/audio | `tokenUsageService`, migrations | M | 1–2 | Clear allowance | Bounded COGS |
| P1-7 | No streaming → SSE for chat/explain + incremental render + regression tests | `aiController`, `groqService`, `app.html` | M | 2 | Feels instant | Retention |
| P1-8 | No math rendering → KaTeX | `app.html` | S | 0.5 | Readable STEM | Core segment |
| P1-9 | Prompt order defeats caching → stable prefix (system + material first, task last) | `groqService` | S | 0.5 | — | ~20–40% less input cost |
| P1-10 | Mixed EN/ID UI and generic prompts → Indonesian-first copy, task-specific prompts for Explain/Forum/Exam | `app.html`, `groqService` | M | 2 | Clarity | Conversion |
| P1-11 | Legal: privacy policy/ToS, UU PDP retention and deletion, 18+ age gate at launch (PP Tunas) | pages, register flow | S/M | 1–2 | — | Compliance |
| P1-12 | Observability: structured logs, Sentry, Groq latency/429 dashboards | server, groqService | S | 1 | — | Ops |
| P1-13 | Tailwind Play CDN → compiled CSS | build, `public/` | M | 1–2 | Faster on low-end phones | Conversion |

### P2: high value
Exam Mode (P2-1, **L, 5–8 d, the main selling point**) · course workspaces + exam-date study plan (P2-2, M/L) · SRS
flashcards (P2-3, M) · learning-mode toggle, *cek jawabanku*, Forum reposition (P2-4, M) · lecture audio → notes (P2-5,
M/L) · chunked retrieval + slide/page citations for long materials (P2-6, L) · chat-agent tool registry (P2-7, M/L) ·
Socratic photo-of-problem (P2-8, M) · pdfjs 6 upgrade with extraction tests (P2-9, S).

### P3: nice to have
`browser_search` "verify a fact" (paid) · `code_interpreter` for programming/statistics · Remote MCP (LMS/Drive) ·
lecturer/class licences · SMA TKA/UTBK track with PP Tunas parental consent · WhatsApp quiz nudges · archive `app2.html` /
`app4.html` and split `app.html` (needs confirmation) · citation formatter.

## 19. Exact implementation plan

### 19.1 Done on this branch (no product decisions required)
1. `chore(deps)`: groq-sdk ^1.6.0, hono / @hono/node-server security patches, `npm audit fix`, `tsx` → dependencies.
2. `feat(ai)`: model migration and AI provider hardening (P0-1…P0-5, P0-8).
3. `fix(security)`: P0-10 quick wins.
4. `test(ai)`: mocked-Groq unit tests + endpoint regression suite for every study tool; `npm run groq:check` live script.
5. `docs`: this report, `.env.example`, README model section.

### 19.2 Waiting for your approval
1. **Positioning:** beachhead = S1 students before UTS/UAS. Main selling point = Exam Mode on own materials.
2. **Pricing:** Free / Pass 7 Hari Rp9.900 / Semester Rp99.000 / Bulanan Rp29.000 / top-ups, metered in kredit.
3. **Payment provider:** Midtrans vs Xendit. Verify QRIS 0% MDR pass-through and the absence of flat fees on small tickets.
4. **Guest policy:** keep anonymous trial (with Turnstile + IP cap) **or** require Google sign-in before the first AI call
   (simplest and cheapest).
5. **Forum tool repositioning** (keep the endpoint, change the prompt to outline/critique).
6. **Persistent storage choice:** Postgres `TEXT` (simplest) vs Cloudflare R2.
7. Then build in order: P1-1 → P1-2/3/4 → P1-6 → P1-5 → P1-7/8/9 → P2-1 Exam Mode.

## 20. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Groq retires or changes models again (6 retirements in 2026) | High | High | All IDs in env, fallback model, provider layer isolated. Consider an OpenAI-compatible secondary provider |
| Vision model is Preview and could be pulled | Medium | Medium | Flag + graceful degrade (done). Optional non-Groq vision fallback |
| Groq Developer tier unavailable (reports of paused upgrades) | Medium | High | Apply early. Free tier (8k TPM) can't serve production |
| Free alternatives (NotebookLM, Google AI Plus for mhs, ChatGPT Free) | Certain | High | Compete on exam workflow, persistence, price and timing, not on chat |
| Low conversion (<3%) | Medium | High | Hard free caps, exam-week passes, lecturer referrals |
| Academic-integrity backlash or campus bans | Medium | Medium | Learning-first defaults, no ghost-writing features, transparency page for lecturers |
| AI-generated questions are wrong | Medium | Medium | Grounding + citations, "laporkan soal", strict schemas, low temperature |
| UU PDP / PP Tunas obligations | Medium | Medium | 18+ at launch, data deletion, retention policy |
| Built-in tool pricing unpublished | Medium | Low | Keep off by default. Meter as kredit |
| Live Groq behaviour unverified from this sandbox | — | Medium | Run `npm run groq:check` locally or in staging before deploying |
| Single maintainer + 5.8k-line HTML frontend | High | Medium | Incremental extraction of modules. No big-bang rewrite |
