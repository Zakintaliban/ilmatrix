/**
 * Kredit metering for registered users.
 *
 * Flow:
 * 1. Pre-request: block the request when the user has no kredit left
 *    (weekly allowance + passes/top-ups), or AI access is disabled
 * 2. Controllers run the AI call inside groqService.track(), which prices
 *    each completion in kredit by the model that served it
 * 3. Post-request: controllers call updateTokenUsageAfterRequest() to charge
 *    the kredit and log the request
 *
 * Guests are limited separately by guestLimitMiddleware.
 */

import type { Context, Next } from 'hono';
import * as tokenUsageService from '../services/tokenUsageService.js';
import * as kreditService from '../services/kreditService.js';
import { kreditForUsage } from '../config/plans.js';
import { isPaymentsEnabled } from '../services/paymentService.js';

const UPGRADE_URL = '/dashboard.html#upgrade';

/**
 * Extract request type from endpoint path
 */
function getRequestType(path: string): string {
  if (path.includes('/explain')) return 'explain';
  if (path.includes('/quiz')) return 'quiz';
  if (path.includes('/chat')) return 'chat';
  if (path.includes('/flashcards')) return 'flashcards';
  if (path.includes('/dialogue')) return 'dialogue';
  if (path.includes('/exam')) return 'exam';
  if (path.includes('/forum')) return 'forum';
  if (path.includes('/upload')) return 'upload';
  return 'default';
}

/** "Senin, 12 Oktober pukul 07.00 WIB" */
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

export function kreditSummary(status: kreditService.KreditStatus) {
  return {
    unit: 'kredit',
    plan: { code: status.plan, name: status.planName, expires_at: status.planExpiresAt },
    weekly: {
      used: status.weeklyUsed,
      limit: status.weeklyLimit,
      remaining: status.weeklyRemaining,
      resets_at: status.weeklyResetsAt,
    },
    extra: { remaining: status.extraRemaining },
    total_remaining: status.totalRemaining,
  };
}

/**
 * Main kredit middleware for AI endpoints
 * Only applies to authenticated users (registered users)
 */
export async function tokenUsageMiddleware(c: Context, next: Next) {
  const user = c.get('user');

  // Guest users are handled separately by guestLimitMiddleware
  if (!user) {
    await next();
    return;
  }

  let status: kreditService.KreditStatus;
  try {
    status = await kreditService.getKreditStatus(user.id);
  } catch (error) {
    // Fail open so a metering outage doesn't take the product down, but loudly
    console.error('[KREDIT] Balance check failed; allowing request unmetered:', error);
    await next();
    return;
  }

  if (!kreditService.canUseAI(status)) {
    const message = !status.accessEnabled
      ? 'Akses AI untuk akunmu sedang dinonaktifkan. Hubungi dukungan ILMATRIX.'
      : `Kredit belajarmu sudah habis. Kredit paket ${status.planName} terisi lagi ${formatResetTime(status.weeklyResetsAt)}.`;
    const canBuy = status.accessEnabled && isPaymentsEnabled();

    return c.json(
      {
        error: canBuy ? `${message} Atau tambah kredit di Dashboard.` : message,
        // Text tools render `answer` as Markdown, so the student sees the reason (and a way out) in the chat
        answer: canBuy ? `${message} Butuh sekarang? [Tambah kredit](${UPGRADE_URL}).` : message,
        code: status.accessEnabled ? 'KREDIT_EXHAUSTED' : 'AI_ACCESS_DISABLED',
        kredit: kreditSummary(status),
        reset_time: status.weeklyResetsAt,
        ...(canBuy ? { upgrade_url: UPGRADE_URL } : {}),
      },
      429
    );
  }

  c.set('kreditStatus', status);
  c.set('requestType', getRequestType(c.req.path));
  await next();
}

/**
 * Charge kredit and log usage after an AI request.
 * Call this from controllers after getting the Groq response.
 *
 * @param c - Hono context
 * @param tokensUsed - Total tokens consumed (from Groq usage)
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
  kredit?: ReturnType<typeof kreditSummary>;
  warning?: string;
  notification?: 'low' | 'critical' | 'exceeded';
}> {
  const user = c.get('user');
  if (!user) {
    // Guest user: not metered in kredit
    return { success: false };
  }

  try {
    const kredit =
      typeof metadata.kredit === 'number'
        ? metadata.kredit
        : kreditForUsage(String(metadata.model || ''), Number(metadata.prompt_tokens) || 0, Number(metadata.completion_tokens) || 0);

    const status = await kreditService.chargeKredit(user.id, kredit, tokensUsed);

    await tokenUsageService.logTokenUsage({
      userId: user.id,
      sessionId: null,
      tokensUsed: Math.max(1, Math.round(tokensUsed)),
      kreditUsed: kredit,
      endpoint: c.req.path,
      modelUsed: metadata.model,
      requestType: c.get('requestType') || getRequestType(c.req.path),
      promptTokens: metadata.prompt_tokens,
      completionTokens: metadata.completion_tokens,
      metadata,
    });

    let warning: string | undefined;
    let notification: 'low' | 'critical' | 'exceeded' | undefined;
    const remainingRatio = status.weeklyLimit > 0 ? status.totalRemaining / status.weeklyLimit : 0;

    if (!status.isAdmin) {
      if (status.totalRemaining <= 0) {
        warning = `Kredit belajarmu sudah habis. Terisi lagi ${formatResetTime(status.weeklyResetsAt)}.`;
        notification = 'exceeded';
      } else if (remainingRatio <= 0.1) {
        warning = `Sisa kredit belajarmu tinggal ${Math.floor(status.totalRemaining)}.`;
        notification = 'critical';
      } else if (remainingRatio <= 0.2) {
        warning = `Kamu sudah memakai sebagian besar kredit minggu ini (sisa ${Math.floor(status.totalRemaining)}).`;
        notification = 'low';
      }
    }

    // A streamed response has already sent its headers (the done event carries the warning)
    if (options.setHeaders !== false) {
      c.header('X-Kredit-Used', kredit.toFixed(2));
      c.header('X-Kredit-Remaining', status.totalRemaining.toFixed(2));
      c.header('X-Kredit-Weekly-Limit', String(status.weeklyLimit));
      if (notification) c.header('X-Kredit-Warning', notification);
    }

    return { success: true, kredit: kreditSummary(status), warning, notification };
  } catch (error) {
    console.error('[KREDIT] Failed to charge kredit:', error);
    return { success: false };
  }
}

/**
 * Middleware that adds kredit balance headers for authenticated users
 */
export async function injectUsageStatsMiddleware(c: Context, next: Next) {
  await next();

  try {
    const user = c.get('user');
    if (!user) return;

    const status = await kreditService.getKreditStatus(user.id);
    c.header('X-Kredit-Remaining', status.totalRemaining.toFixed(2));
    c.header('X-Kredit-Weekly-Limit', String(status.weeklyLimit));
  } catch (error) {
    console.error('Error injecting usage stats:', error);
    // Don't fail the request
  }
}
