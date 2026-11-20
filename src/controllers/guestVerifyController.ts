import type { Context } from 'hono';
import { guestSessionService } from '../services/guestSessionService.js';
import { guestIpLimiter } from '../services/guestIpLimiter.js';
import { isTurnstileEnabled, verifyTurnstileToken } from '../services/turnstileService.js';
import { getClientIp } from '../utils/security.js';
import { guestIpLimitReached } from '../middleware/guestLimit.js';
import config from '../config/env.js';

/**
 * POST /api/guest/verify  { token }
 * Validates a Turnstile token and marks this guest device as human.
 */
export async function verifyGuest(c: Context) {
  if (!isTurnstileEnabled()) {
    return c.json({ ok: true, verification: 'disabled' });
  }

  const ip = getClientIp(c);
  if (!guestIpLimiter.canVerify(ip)) {
    return c.json(guestIpLimitReached(), 429);
  }

  const { token } = await c.req.json().catch(() => ({ token: undefined }));
  const result = await verifyTurnstileToken(token, ip);
  if (!result.success) {
    return c.json(
      { error: 'Verifikasi gagal. Muat ulang halaman lalu coba lagi.', code: 'TURNSTILE_FAILED', error_codes: result.errorCodes },
      403
    );
  }

  guestIpLimiter.recordVerification(ip);
  guestSessionService.markVerified(c);
  return c.json({ ok: true });
}

/**
 * GET /api/admin/client-ip (admin only)
 * Shows which IP the server sees for you, to check CLIENT_IP_HEADER after deploying.
 */
export function getClientIpInfo(c: Context) {
  return c.json({
    detected_ip: getClientIp(c),
    client_ip_header: config.clientIpHeader,
    headers: {
      'x-real-ip': c.req.header('x-real-ip') || null,
      'x-forwarded-for': c.req.header('x-forwarded-for') || null,
      'cf-connecting-ip': c.req.header('cf-connecting-ip') || null,
    },
  });
}
