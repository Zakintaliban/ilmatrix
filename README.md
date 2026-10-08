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

- The app extracts text from uploaded files (PDF/DOCX/PPTX/Images/TXT) and stores only the extracted text in the Postgres
  `materials` table (or `uploads/<materialId>.txt` when no database is configured)
- **Original files are never saved** - only the extracted text content
- Signed-in users' materials are private to them; guest materials are reachable only by their (unguessable) ID.
  A signed-in user who uses a guest upload (e.g. right after logging in) takes ownership of it

### Size Limits

- **10 MB total** per material (enforced at upload/append)
- Individual file size limits handled by extraction services

### Retention

| Material | Kept for | Setting |
|---|---|---|
| Guest upload | 60 minutes after last use | `MATERIAL_TTL_MINUTES` |
| Signed-in upload | 180 days after last use | `MATERIAL_USER_RETENTION_DAYS` |
| Saved to the library | until the user deletes it (or their account) | — |

- Signed-in users can store up to `MATERIAL_USER_QUOTA_MB` (default 200 MB) of extracted text
- A background cleaner deletes expired materials ([backgroundTaskService](src/services/backgroundTaskService.ts)); deleting
  an account deletes its materials

### Kredit & plans

AI usage by signed-in users is metered in **kredit**, a cost-weighted unit (1 kredit ≈ Rp4 of AI cost, priced per model
in [src/config/plans.ts](src/config/plans.ts)). A grounded answer costs ~9 kredit, a 10-question quiz ~17, a photo ~36.

| Plan / product | Price | Kredit |
|---|---|---|
| Gratis | Rp0 | 150 per week (`KREDIT_FREE_WEEKLY`) |
| Bulanan | Rp29.000 / 30 days | 900 per week |
| Semester | Rp99.000 / 182 days | 700 per week |
| Pass 7 Hari | Rp9.900 | 1.000, valid 7 days |
| Top-up | Rp5.000 | 600, valid 90 days |

- Weekly kredit refill every Monday 00:00 UTC (07:00 WIB); passes and top-ups are used after the weekly allowance,
  soonest-expiring first. A request is allowed while any kredit remains (the last one may overshoot slightly)
- When kredit runs out, AI endpoints return `429` with `code: "KREDIT_EXHAUSTED"` and a message students see in the app;
  image uploads still work but skip OCR
- Admins are metered but never blocked. Sales outside Midtrans (e.g. a manual transfer) can still be applied from the
  admin page (`/admin-usage.html` → user → Set Plan / Grant Pass 7 Hari / Grant Top-up) or the API:
  `POST /api/admin/usage/user/:id/set-plan {"plan":"semester"}` and
  `POST /api/admin/usage/user/:id/grant-kredit {"product":"pass_7d","reference":"QRIS-..."}`

### Streaming

Chat and the Explain/Quiz/Forum/Exam answers stream token by token (Server-Sent Events,
[aiController](src/controllers/aiController.ts), [GroqProvider.stream](src/services/groqProvider.ts)):

- The fallback model is used only if the primary fails before any text was sent; after that a failure ends the stream
  with an `error` event (the app keeps the partial answer and notes that it broke off)
- Reasoning is never streamed (`include_reasoning: false`, and only `delta.content` is forwarded)
- Kredit is charged when the stream ends, from the usage Groq sends in its final chunk (`x_groq.usage`). If the student
  closes the page, the Groq request is aborted and the tokens used are estimated (~4 characters per token); a stream
  that ends without usage is estimated too (a warning is logged). `npm run groq:check` verifies against the live API
  that usage arrives in the stream
- The AI rate-limit slot and the Groq concurrency slot are held until the stream ends. A stream that sends nothing
  for `GROQ_TIMEOUT_MS` times out
- Proxies: responses carry `Cache-Control: no-cache` and `X-Accel-Buffering: no`, and a keep-alive comment is sent
  every 15 s while the model is thinking

### Payments (Midtrans)

Students buy passes, top-ups and plans from the dashboard (**Tambah Kredit**) with Midtrans Snap: QRIS, e-wallets,
bank transfer, whatever is active on the merchant account (narrow it with `MIDTRANS_ENABLED_PAYMENTS`). Snap runs in
redirect mode: the student is sent to Midtrans' hosted page and back to `/payment.html`, so no Midtrans script runs on
our pages. Code: [paymentService](src/services/paymentService.ts), [midtransClient](src/services/midtransClient.ts).

- **Checkout** `POST /api/payments/checkout {"product":"pass_7d"}` (signed in) creates a pending payment with the
  catalogue price and returns Midtrans' `redirect_url`. A pending checkout of the same product from the last hour is
  reused; at most 5 checkouts per user per hour
- **Webhook** `POST /api/payments/midtrans/notification`: the SHA-512 `signature_key` is checked, then the real status
  is fetched from Midtrans' Get Status API (the signature doesn't cover `transaction_status`). If Midtrans can't be
  reached the webhook answers `503`, so Midtrans retries
- **Return page** polls `GET /api/payments/:orderId`, which re-checks a pending payment with Midtrans (at most every
  10 s). A sale is completed even if the webhook never arrives
- **Fulfilment** happens exactly once (row lock), only when the amount matches exactly: `settlement`, or `capture` with
  fraud status `accept`. Pass/Top-up add kredit; a plan starts or, if it's the same plan, extends. A different paid
  plan can't be bought while one is active (passes and top-ups can)
- **Refunds/chargebacks** after fulfilment mark the payment `refunded` and add a review note; the plan or kredit is not
  revoked automatically. Amount mismatches are never fulfilled and also get a review note. Both show on the admin
  page (**Payments**), which can re-check any payment with Midtrans
- Payments are kept when an account is deleted (`user_id` set to NULL); every received or fetched status is stored in
  `payment_events`

Setup:

1. Run `npm run migrate run` (migration 014 creates `payments` and `payment_events`)
2. Set `MIDTRANS_SERVER_KEY` (sandbox key first) and `MIDTRANS_IS_PRODUCTION=false`; the server warns if the key and
   the environment don't match
3. Webhook: with an `https://` `BASE_URL`, each transaction tells Midtrans to notify
   `${BASE_URL}/api/payments/midtrans/notification`. Otherwise set that URL as the Notification URL in the Midtrans
   dashboard (Settings > Payment). For local testing a tunnel is needed; without one the return page still completes
   payments by polling
4. Test in sandbox with Midtrans' simulator, then switch to production keys and `MIDTRANS_IS_PRODUCTION=true`
5. Consider `MIDTRANS_ENABLED_PAYMENTS=other_qris,gopay,shopeepay`: bank virtual accounts usually carry a flat fee per
   transaction (often Rp2–5k), too much for a Rp5.000 top-up. Confirm current rates with Midtrans

### Guest access & bot protection

Guests (no account) get 5 AI uses per device. Because a device is just a cookie, three more checks bound what a script
can take without signing up ([guestLimit](src/middleware/guestLimit.ts)):

- **Turnstile** (when `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set): a new guest device must pass a
  Cloudflare Turnstile check before its first AI request or image upload. The app does this automatically
  ([public/js/guest-verify.js](public/js/guest-verify.js)): the API answers `401` with
  `code: "GUEST_VERIFICATION_REQUIRED"`, the browser runs the (usually invisible) challenge, posts the token to
  `POST /api/guest/verify` and retries. Tokens are validated server-side and never trusted from the client
- **Per-IP daily caps**: `GUEST_IP_DAILY_REQUESTS` AI requests (default 100) and `GUEST_IP_DAILY_VERIFICATIONS`
  device verifications (default 20) per IP per 24 hours, across all devices. Hitting a cap asks the student to sign up
  (`code: "GUEST_IP_LIMIT"`)
- **Trusted client IP**: the IP comes from the header named by `CLIENT_IP_HEADER`, never from the client-controlled
  first `X-Forwarded-For` entry
- Signed-in users skip all of this and are limited by kredit. Counters are in memory, so they reset on restart and are
  per instance

### Deployment

- Run `npm run migrate run` after deploying so the `materials` table exists (PostgreSQL 12+). Until then the app logs a
  warning and falls back to local files, which do not survive a redeploy
- Without a database (local development), materials use `uploads/<id>.txt` files with the guest TTL
- Migration 013 hashes existing session tokens in place, so users stay signed in. When an email service is configured,
  accounts that never verified their email must verify before their next password sign-in
- After deploying, open `GET /api/admin/client-ip` as an admin and check that `detected_ip` is your real IP. If it is
  a proxy address, set `CLIENT_IP_HEADER` (`cf-connecting-ip` when the domain is proxied through Cloudflare; the server
  logs a `[CLIENT_IP]` warning when it sees Cloudflare headers without that setting)
- Create a Turnstile widget for your domain (Managed mode) and set `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`

Students upload their materials and get help:
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
npm run test:db       # Postgres material storage (needs TEST_DATABASE_URL to a disposable database; skipped otherwise)
npm run test:smoke    # Integration tests (API endpoints)
npm run groq:check    # Live check of every study tool against the real Groq API (needs GROQ_API_KEY)
```

Run `npm run groq:check` before deploying any model or SDK change: the automated tests use a fake Groq
client and cannot detect a model being retired or rejecting a parameter.

Test files:

- `tests/services/` - Service layer unit tests
- `tests/ai/` - AI provider unit tests, the study-tool regression suite, streaming (SSE), guest protection (Turnstile, IP caps, client IP) and the AI rate limiter
- `tests/db/` - Tests against a real Postgres (`TEST_DATABASE_URL=postgresql://... npm run test:db`; the database is migrated and receives test rows)
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
- MATERIAL_TTL_MINUTES: Minutes to keep guest materials after their last use (default 60). Also the TTL of file-based storage when no database is configured.
- MATERIAL_USER_RETENTION_DAYS: Days to keep signed-in users' materials after their last use (default 180). Materials saved to the library are kept until deleted.
- MATERIAL_USER_QUOTA_MB: Maximum extracted text stored per signed-in user (default 200).
- KREDIT_FREE_WEEKLY: Weekly kredit on the free plan (default 150). Paid plans and products are defined in [src/config/plans.ts](src/config/plans.ts).
- DATABASE_SSL: `true`/`false` to override database SSL (default: on when NODE_ENV=production). Note that npm runs every script with NODE_ENV=production because `.npmrc` sets `omit=dev`, so set `DATABASE_SSL=false` for a local Postgres without SSL.
- RATE_LIMIT_MAX: Requests per minute per IP (default 120). Lightweight token bucket applied to all /api routes. See [middleware](src/routes.ts:70).
- AI_RATE_LIMIT_PER_MINUTE / AI_RATE_LIMIT_PER_HOUR: AI requests per user (guests: per device) in sliding 1-minute and 1-hour windows (defaults 12 and 150). See [aiRateLimit](src/middleware/aiRateLimit.ts).
- AI_MAX_CONCURRENT: AI requests one user/device may have in flight (default 2); more get an immediate `429` instead of queueing for the shared Groq slots.
- PDF_MAX_PAGES: Max PDF pages extracted per file (default 200). See [extractPdfTextImpl()](src/extract/pdf.ts:50).
- GROQ_CONCURRENCY: Concurrent LLM requests per process, including image OCR (default 4). See [groqProvider](src/services/groqProvider.ts).
- GROQ_TIMEOUT_MS: Per-request LLM timeout in ms, enforced by the Groq SDK (default 45000). See [groqProvider](src/services/groqProvider.ts).
- EXTRACTION_CONCURRENCY: Max concurrent file extraction operations (default 2). See [extractionService](src/services/extractionService.ts).
- CLIENT_IP_HEADER: Header holding the real client IP: `x-real-ip` (default, Railway), `cf-connecting-ip` (behind Cloudflare), `x-forwarded-for` (rightmost entry) or `none` (socket address). Used by every per-IP limit.
- TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY: Cloudflare Turnstile keys for the guest bot check. Both must be set to enable it.
- GUEST_IP_DAILY_REQUESTS: Guest AI requests per IP per 24 hours (default 100).
- GUEST_IP_DAILY_VERIFICATIONS: Guest device verifications per IP per 24 hours (default 20).
- MIDTRANS_SERVER_KEY: Midtrans server key; payments are off without it. Never sent to the browser.
- MIDTRANS_IS_PRODUCTION: `true` for real payments (default `false`, sandbox).
- MIDTRANS_ENABLED_PAYMENTS: Comma-separated Snap payment methods to offer (default: all active on the account).
- MIDTRANS_NOTIFICATION_URL: Webhook URL sent per transaction (default: `${BASE_URL}/api/payments/midtrans/notification` when BASE_URL is https).

## Storage & retention

- What’s stored:
  - The app extracts text from your uploaded files (PDF/DOCX/PPTX/Images/TXT) and stores only the extracted text in Postgres (`materials` table). Originals are not saved.
- Size limits:
  - 10 MB of extracted text per upload; `MATERIAL_USER_QUOTA_MB` (default 200) per signed-in user.
- Retention:
  - Guest materials: `MATERIAL_TTL_MINUTES` after last use. Signed-in: `MATERIAL_USER_RETENTION_DAYS` after last use. Saved to the library: until deleted. See the retention table at the top of this README.
- Without a database:
  - Materials fall back to `uploads/<materialId>.txt` files with the guest TTL; on platforms with ephemeral disks they vanish on redeploy.

## Security & accessibility

- Security hardening:
  - Path traversal protection for materials I/O; only UUID v4-like ids are accepted and paths are validated inside uploads/ (see [security utils](src/utils/security.ts)).
  - Global per-IP rate limiting (default 120 req/min) via a lightweight token bucket (see [rate limit middleware](src/middleware/rateLimit.ts)). Tune with RATE_LIMIT_MAX.
  - AI rate limiting per user or guest device on every AI endpoint: 12/min and 150/hour (sliding windows), at most 2 in flight. Rejected requests return `429` with `code: "AI_RATE_LIMITED"` or `"AI_CONCURRENCY_LIMIT"`, a message in `error`/`answer` and `Retry-After`; they are not charged kredit and do not use a guest trial (see [aiRateLimit](src/middleware/aiRateLimit.ts)). In memory, per instance.
  - Security headers on every response ([securityHeaders](src/middleware/securityHeaders.ts)): a site-wide Content-Security-Policy (script origins pinned, no plugins, no `<base>` hijacking, forms only to this site, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, HSTS, `nosniff`, a strict referrer policy and a Permissions-Policy. Pages with a `<meta>` CSP ([app](public/app.html), [index](public/index.html), [about](public/about.html)) narrow it further. `'unsafe-inline'` remains until inline scripts move to files.
  - CDN scripts are pinned to exact versions with Subresource Integrity (`integrity` + `crossorigin`), checked by a test. Exception: the Tailwind Play CDN, which generates its script per request (replace with compiled CSS, P1-13).
  - Guest bot protection: Turnstile device verification and per-IP daily caps (see [Guest access & bot protection](#guest-access--bot-protection)).
  - Request body limits while streaming: 2 MB for JSON, the upload limit (+1 MB) for `/upload`; `413 BODY_TOO_LARGE`.
  - DOCX/PPTX are read with a decompression budget (50 MB of XML per document), so a zip bomb fails the upload instead of exhausting memory ([zip](src/extract/zip.ts)).
- Accounts:
  - Password sign-in requires a verified email whenever verification emails can be sent (`RESEND_API_KEY` set); the login page offers to resend the link. Without an email service nobody could verify, so the check is off.
  - Google sign-in into an existing **unverified** account takes it over: its password and sessions are removed (stops account pre-hijacking). The profile API can't change the email.
  - Google OAuth uses a `state` parameter bound to an HttpOnly cookie (login CSRF).
  - Failed sign-ins: 10 per email or 30 per IP within 15 minutes, then `429 LOGIN_THROTTLED` (Google sign-in still works). Changing the password signs out other sessions.
  - Session tokens are stored as SHA-256 hashes (migration 013); the cookie value never reaches the database.
  - User-supplied names are HTML-escaped in emails.
- Accessibility:
  - Live regions announce new chat and dialogue messages for screen readers (see [app live regions](public/app.html)).
  - Tool trigger buttons include aria-label/controls/expanded for improved navigation.

## API

Base: /api

- GET /api/health → { "ok": true, "uptime": number }

- Payments: `GET /api/payments/products` (public), `POST /api/payments/checkout`, `GET /api/payments`,
  `GET /api/payments/:orderId` (signed in), `POST /api/payments/midtrans/notification` (Midtrans),
  `GET /api/admin/payments?status=`, `POST /api/admin/payments/:orderId/sync` (admin). See [Payments](#payments-midtrans).

- POST /api/guest/verify (application/json)

  - Body: { token: string } // Turnstile widget token
  - Response: { "ok": true } and the device is verified; 403 `TURNSTILE_FAILED`; 429 `GUEST_IP_LIMIT`; { "ok": true, "verification": "disabled" } when Turnstile is not configured

- GET /api/admin/client-ip (admin) → { detected_ip, client_ip_header, headers } // check CLIENT_IP_HEADER after deploying

- POST /api/upload (multipart/form-data)

  - Field "file": may appear multiple times to upload multiple files in one batch (PDF/TXT/PNG/JPG/DOCX/PPTX)
  - Optional when appending to an existing material: append=true, mergeTo=<materialId> (or materialId=<id>)
  - Response: { "materialId": "uuid", "appended": boolean, "files": number, "size": number, "sizeAdded": number, "limit": "10MB" }

- POST /api/explain (application/json)

  - Body: { materialId?: string, materialText?: string, prompt?: string, stream?: boolean }
  - Response: { "answer": string }, or with `"stream": true` a Server-Sent Events stream (see [Streaming](#streaming))

- Streaming: `/api/explain`, `/api/quiz`, `/api/forum`, `/api/exam` and `/api/chat` accept `"stream": true` and answer
  as `text/event-stream`:

  ```
  event: start   data: {}
  event: delta   data: {"text": "..."}                                   (repeated)
  event: done    data: {"answer": "...", "token_usage": {...}, "usage_warning": "..."}
  event: error   data: {"error": "...", "code": "timeout|unavailable|..."}   (instead of done)
  ```

  Validation, auth, kredit and rate limits answer with normal JSON errors before the stream opens. The app uses
  streaming for chat and the Explain/Forum/Exam panels

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
  - Vector search for large materials
  - Streaming for the JSON tools (quiz trainer, flashcards, dialogue) once the UI can show partial results

## Troubleshooting

- “Server is missing GROQ_API_KEY”: set GROQ_API_KEY in .env and restart
- Health is ok but UI fails: check browser console and network panel
- PDF extraction issues: try another PDF or verify pdfjs-dist is installed
- TypeScript module warnings in editor: restart TS server/VS Code (runtime resolution is correct)

## License

Apache-2.0 License
