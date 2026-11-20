/**
 * Daily/weekly AI quotas for signed-in users (see quotaService.ts).
 *
 * Flow per AI request:
 * 1. Before: reserve a conservative estimate for the tool. Refused when
 *    either quota lacks room (429 QUOTA_EXCEEDED) or AI access is disabled;
 *    if the database can't answer, the request is refused (503), never run
 *    unmetered.
 * 2. The handler runs inside observeCost(), which adds up every completion's
 *    real kredit, even when the handler later fails.
 * 3. After: controllers call updateTokenUsageAfterRequest() to settle the
 *    reservation and log the request. Whatever is still open when the handler
 *    returns (errors, early exits, a settlement that failed) is settled then,
 *    from the larger of the reported and observed cost: 0 releases the
 *    reservation. Streams settle themselves when they end. If the database
 *    refuses every attempt, the reservation expires and is charged in full.
 *
 * Guests are limited separately by guestLimitMiddleware.
 */

import type { Context, Next } from 'hono';
import * as tokenUsageService from '../services/tokenUsageService.js';
import * as quotaService from '../services/quotaService.js';
import { reservationKredit } from '../services/quotaEstimates.js';
import { observeCost, type CostSink } from '../services/groqProvider.js';
import { kreditForUsage } from '../config/inferenceCost.js';
import { isPaymentsEnabled } from '../services/paymentService.js';

const UPGRADE_URL = '/dashboard.html#upgrade';
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Reservation of the current request (stored on the context). */
export interface QuotaReservation {
  id: string;
  amount: number;
  /** What the request's completions really cost so far (observed in the provider). */
  cost: CostSink;
  /** Kredit a controller reported; settlement never charges less than this or `cost`. */
  charge: number;
  /** Set only once the database has settled it (or found it already settled). */
  finished: boolean;
  /** The request is in token_usage_logs (logged once, whatever happens to settlement). */
  logged: boolean;
}

/** Tool behind an AI endpoint path. */
export function getRequestType(path: string): quotaService.QuotaTool {
  if (path.includes('/mcq')) return 'mcq';
  if (path.includes('/explain')) return 'explain';
  if (path.includes('/quiz')) return 'quiz';
  if (path.includes('/chat')) return 'chat';
  if (path.includes('/flashcards')) return 'flashcards';
  if (path.includes('/dialogue')) return 'dialogue';
  if (path.includes('/exam')) return 'exam';
  if (path.includes('/forum')) return 'forum';
  if (path.includes('/upload')) return 'ocr';
  return 'explain';
}

/** "Senin, 12 Oktober pukul 00.00 WIB" */
export function formatResetTime(date: Date): string {
  const text = date.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${text} WIB`;
}

/** 429 body for a refused request: which quota, how much is left and when it resets. */
export function quotaExceededBody(result: Extract<quotaService.ReserveResult, { ok: false }>) {
  if (result.reason === 'access_disabled') {
    const message = 'Akses AI untuk akunmu sedang dinonaktifkan. Hubungi admin ILMATRIX.';
    return { error: message, answer: message, code: 'AI_ACCESS_DISABLED', quota: quotaService.quotaSummary(result.status) };
  }
  const window = result.status[result.period];
  const label = result.period === 'daily' ? 'harian' : 'mingguan';
  const left =
    window.remaining > 0
      ? ` Sisa ${Math.floor(window.remaining)} kredit belum cukup untuk permintaan ini (perlu sekitar ${Math.ceil(result.required)}).`
      : '';
  let message = `Batas pemakaian AI ${label}-mu sudah tercapai.${left} Terisi lagi ${formatResetTime(result.resetsAt)}.`;
  const canBuy = isPaymentsEnabled();
  if (canBuy) message += ' Atau tambah kredit di Dashboard.';
  return {
    error: message,
    // Text tools render `answer` as Markdown, so the student sees the reason in the chat
    answer: canBuy ? `${message} [Tambah kredit](${UPGRADE_URL}).` : message,
    code: 'QUOTA_EXCEEDED',
    limit: result.period,
    exhausted: result.exhausted,
    required: result.required,
    resets_at: result.resetsAt,
    quota: quotaService.quotaSummary(result.status),
    ...(canBuy ? { upgrade_url: UPGRADE_URL } : {}),
  };
}

/** 503 when the quota can't be checked: AI requests are never run unmetered. */
export function quotaUnavailable(c: Context, error: unknown) {
  console.error('[QUOTA] Quota check failed; refusing the AI request:', error);
  const message = 'Pemakaian AI tidak bisa diperiksa saat ini. Coba lagi sebentar lagi.';
  return c.json({ error: message, answer: message, code: 'QUOTA_UNAVAILABLE' }, 503);
}

/** Kredit to reserve for this request (reads the cached JSON body for counts). */
async function estimateFor(c: Context, tool: quotaService.QuotaTool): Promise<number> {
  if (tool !== 'mcq' && tool !== 'flashcards') return reservationKredit(tool);
  const body: any = await c.req.json().catch(() => ({}));
  const raw = Math.floor(Number(tool === 'mcq' ? body?.numQuestions : body?.numCards));
  const count = Number.isFinite(raw) ? Math.min(50, Math.max(1, raw)) : undefined;
  return reservationKredit(tool, { count });
}

/**
 * Reserve quota for an AI request by `userId`. Returns the reservation, or a
 * Response to send instead (429 refused, 503 quota unavailable).
 */
export async function reserveQuota(
  c: Context,
  userId: string,
  tool: quotaService.QuotaTool,
  amount?: number
): Promise<QuotaReservation | Response> {
  let result: quotaService.ReserveResult;
  try {
    result = await quotaService.reserve(userId, tool, amount ?? (await estimateFor(c, tool)));
  } catch (error) {
    return quotaUnavailable(c, error);
  }
  if (!result.ok) return c.json(quotaExceededBody(result), 429);
  const reservation: QuotaReservation = {
    id: result.reservationId,
    amount: result.amount,
    cost: { kredit: 0 },
    charge: 0,
    finished: false,
    logged: false,
  };
  c.set('quotaReservation', reservation);
  c.set('requestType', tool);
  return reservation;
}

/**
 * Settle a reservation in the database. `finished` is set only when that
 * succeeds; on failure it stays open so the end of the request can retry, and
 * if every attempt fails the reservation expires and is charged in full.
 * Retrying can't double-charge: quotaService.finish() is idempotent.
 */
async function settle(reservation: QuotaReservation): Promise<{ kredit: number; status: quotaService.QuotaStatus | null } | null> {
  const kredit = round2(Math.max(reservation.charge, reservation.cost.kredit));
  try {
    const status = await quotaService.finish(reservation.id, kredit);
    reservation.finished = true;
    return { kredit, status };
  } catch (error) {
    console.error(`[QUOTA] Could not settle reservation ${reservation.id} (${kredit} kredit); retrying when the request ends, else charged in full on expiry:`, error);
    return null;
  }
}

/** Write the request to token_usage_logs once. A logging failure never affects the quota. */
async function logOnce(c: Context, reservation: QuotaReservation, entry: Omit<Parameters<typeof tokenUsageService.logTokenUsage>[0], 'userId' | 'sessionId' | 'endpoint'>) {
  if (reservation.logged) return;
  try {
    await tokenUsageService.logTokenUsage({ userId: c.get('user').id, sessionId: null, endpoint: c.req.path, ...entry });
    reservation.logged = true;
  } catch (error) {
    console.error('[QUOTA] Could not log AI usage (the quota is unaffected):', error);
  }
}

/**
 * Settle this request's reservation if it is still open: the controller never
 * did (errors, early exits) or its settlement failed. Safe to call more than once.
 */
export async function finishQuota(c: Context): Promise<void> {
  const reservation: QuotaReservation | undefined = c.get('quotaReservation');
  if (!reservation || reservation.finished) return;
  const settled = await settle(reservation);
  if (settled && settled.kredit > 0) {
    await logOnce(c, reservation, {
      tokensUsed: 1,
      kreditUsed: settled.kredit,
      requestType: c.get('requestType'),
      metadata: { settled_from: 'observed_cost' },
    });
  }
}

/** Main quota middleware for AI endpoints (signed-in users only). */
export async function tokenUsageMiddleware(c: Context, next: Next) {
  const user = c.get('user');
  if (!user) {
    await next();
    return;
  }

  const reservation = await reserveQuota(c, user.id, getRequestType(c.req.path));
  if (reservation instanceof Response) return reservation;

  try {
    await observeCost(reservation.cost, () => next());
  } finally {
    // A stream is still running: it settles when it ends (aiController.streamAnswer)
    if (!c.res.headers.get('content-type')?.startsWith('text/event-stream')) await finishQuota(c);
  }
}

/**
 * Settle the quota reservation and log usage after an AI request.
 * Call this from controllers after getting the model's response.
 *
 * @param c - Hono context
 * @param tokensUsed - Total tokens consumed
 * @param metadata - model, prompt_tokens, completion_tokens, kredit (from
 *   groqService.track) and any extra context to log
 */
export async function updateTokenUsageAfterRequest(
  c: Context,
  tokensUsed: number,
  metadata: Record<string, any> = {},
  options: { setHeaders?: boolean } = {}
): Promise<{
  success: boolean;
  quota?: ReturnType<typeof quotaService.quotaSummary>;
  warning?: string;
  notification?: 'low' | 'critical' | 'exceeded';
}> {
  const user = c.get('user');
  const reservation: QuotaReservation | undefined = c.get('quotaReservation');
  if (!user || !reservation || reservation.finished) {
    // Guests are not metered in kredit
    return { success: false };
  }

  try {
    const reported =
      typeof metadata.kredit === 'number'
        ? metadata.kredit
        : kreditForUsage(String(metadata.model || ''), Number(metadata.prompt_tokens) || 0, Number(metadata.completion_tokens) || 0);
    // Remembered for a retry (finishQuota) if this settlement fails
    reservation.charge = round2(Math.max(reservation.charge, reported));

    const settled = await settle(reservation);
    // The usage happened either way, so it is logged even if settlement must be retried
    await logOnce(c, reservation, {
      tokensUsed: Math.max(1, Math.round(tokensUsed)),
      kreditUsed: settled?.kredit ?? round2(Math.max(reservation.charge, reservation.cost.kredit)),
      modelUsed: metadata.model,
      requestType: c.get('requestType') || getRequestType(c.req.path),
      promptTokens: metadata.prompt_tokens,
      completionTokens: metadata.completion_tokens,
      metadata,
    });
    if (!settled) return { success: false };
    const { kredit, status } = settled;
    if (!status) return { success: true };

    // Warn about whichever quota is closest to running out
    const share = (w: quotaService.QuotaWindow) => (w.limit > 0 ? w.remaining / w.limit : 0);
    const [window, label] =
      share(status.daily) <= share(status.weekly) ? [status.daily, 'hari ini'] : [status.weekly, 'minggu ini'];
    let warning: string | undefined;
    let notification: 'low' | 'critical' | 'exceeded' | undefined;
    if (!status.exempt) {
      if (window.remaining <= 0) {
        warning = `Kuota AI ${label} sudah habis. Terisi lagi ${formatResetTime(window.resetsAt)}.`;
        notification = 'exceeded';
      } else if (share(window) <= 0.1) {
        warning = `Sisa kuota AI ${label} tinggal ${Math.floor(window.remaining)} kredit.`;
        notification = 'critical';
      } else if (share(window) <= 0.2) {
        warning = `Kuota AI ${label} hampir habis (sisa ${Math.floor(window.remaining)} kredit).`;
        notification = 'low';
      }
    }

    // A streamed response has already sent its headers (the done event carries the warning)
    if (options.setHeaders !== false) {
      c.header('X-Kredit-Used', kredit.toFixed(2));
      c.header('X-Kredit-Remaining', Math.min(status.daily.remaining, status.weekly.remaining).toFixed(2));
      c.header('X-Quota-Daily-Remaining', status.daily.remaining.toFixed(2));
      c.header('X-Quota-Weekly-Remaining', status.weekly.remaining.toFixed(2));
      if (notification) c.header('X-Kredit-Warning', notification);
    }

    return { success: true, quota: quotaService.quotaSummary(status), warning, notification };
  } catch (error) {
    // Unexpected: whatever is still open is settled by finishQuota when the request ends
    console.error('[QUOTA] Failed to settle quota:', error);
    return { success: false };
  }
}
