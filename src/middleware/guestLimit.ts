import { Context, Next } from 'hono';
import { guestSessionService } from '../services/guestSessionService.js';
import { getUserBySessionToken } from '../services/authService.js';
import { behaviorAnalysisService } from '../services/behaviorAnalysisService.js';
import { guestIpLimiter } from '../services/guestIpLimiter.js';
import { isTurnstileEnabled, getTurnstileSiteKey } from '../services/turnstileService.js';
import { getClientIp } from '../utils/security.js';

/** 401 body asking the browser to pass Turnstile, then retry (see app.html). */
export function guestVerificationRequired() {
  const message = 'Verifikasi singkat dulu sebelum mencoba ILMATRIX sebagai tamu.';
  return {
    error: message,
    answer: message,
    code: 'GUEST_VERIFICATION_REQUIRED',
    requiresAuth: false,
    turnstile_site_key: getTurnstileSiteKey(),
  };
}

/** Body for a network that has used up its guest allowance today. */
export function guestIpLimitReached() {
  return {
    error: 'Batas penggunaan tamu dari jaringan ini sudah tercapai hari ini. Daftar gratis untuk lanjut belajar.',
    code: 'GUEST_IP_LIMIT',
    requiresAuth: true,
    loginUrl: '/login.html',
  };
}

/**
 * Get current user from session token in request
 */
async function getCurrentUser(c: Context) {
  const sessionToken = getSessionFromRequest(c);
  if (!sessionToken) return null;
  
  return await getUserBySessionToken(sessionToken);
}

/**
 * Extract session token from request (cookie or header)
 */
function getSessionFromRequest(c: Context): string | null {
  // Try to get from cookie first
  const cookieHeader = c.req.header('cookie');
  if (cookieHeader) {
    const sessionMatch = cookieHeader.match(/session=([^;]+)/);
    if (sessionMatch) {
      return sessionMatch[1];
    }
  }
  
  // Try to get from Authorization header
  const authHeader = c.req.header('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  
  return null;
}

/**
 * Middleware that enforces usage limits for guest users
 * Authenticated users get unlimited access
 * Guest users are limited to 5 uses before forced login
 *
 * Also tracks behavioral patterns for abuse detection
 */
export async function guestLimitMiddleware(c: Context, next: Next) {
  const endpoint = c.req.path;

  // First check if user is authenticated. A failed lookup is treated as a
  // guest (previously any error here let the request through with no limits).
  let user = null;
  try {
    user = await getCurrentUser(c);
  } catch (error) {
    console.error('Guest limit middleware: session lookup failed, treating as guest:', error);
  }

  if (user) {
    // Authenticated user: limited by kredit instead
    c.header('X-Auth-Status', 'authenticated');
    c.header('X-User-ID', user.id);
    return next();
  }

  // Guest user: device = random HttpOnly cookie, ip = trusted client IP
  const fingerprint = guestSessionService.generateFingerprint(c);
  const deviceId = fingerprint; // Store for behavioral tracking
  const ip = getClientIp(c);

  // Check if device is flagged as suspicious
  if (behaviorAnalysisService.isSuspicious(deviceId)) {
    console.warn(`⚠️  Suspicious device ${deviceId.substring(0, 8)}... attempting access`);
    c.header('X-Suspicious-Activity', 'true');
  }

  // A new device (e.g. cookies cleared) must pass Turnstile before using AI
  if (isTurnstileEnabled() && !guestSessionService.isVerified(fingerprint)) {
    behaviorAnalysisService.trackRequest(deviceId, c, endpoint, 401);
    return c.json(guestVerificationRequired(), 401);
  }

  // Per-network daily cap (shared by every device behind the same IP)
  if (!guestIpLimiter.canRequest(ip)) {
    behaviorAnalysisService.trackRequest(deviceId, c, endpoint, 401);
    return c.json(guestIpLimitReached(), 401);
  }

  // Check if already at limit
  if (guestSessionService.isLimitReached(fingerprint)) {
    // Track limit exceeded (401 response)
    behaviorAnalysisService.trackRequest(deviceId, c, endpoint, 401);

    return c.json({
      error: 'Trial limit reached! Create a free account to continue using ILMATRIX.',
      code: 'GUEST_LIMIT_EXCEEDED',
      requiresAuth: true,
      usageLimits: {
        current: 5,
        max: 5,
        remaining: 0
      },
      loginUrl: '/login.html'
    }, 401);
  }

  // Increment usage for this request
  const usageResult = guestSessionService.incrementUsage(c);
  guestIpLimiter.recordRequest(ip);

  // Add usage headers for frontend
  c.header('X-Auth-Status', 'guest');
  c.header('X-Guest-Usage-Current', usageResult.newCount.toString());
  c.header('X-Guest-Usage-Max', '5');
  c.header('X-Guest-Usage-Remaining', usageResult.remaining.toString());
  c.header('X-Guest-Fingerprint', fingerprint);

  // Show warning when approaching limit
  if (usageResult.remaining <= 1) {
    c.header('X-Guest-Warning', 'true');
  }

  // Track successful request for behavioral analysis
  behaviorAnalysisService.trackRequest(deviceId, c, endpoint, 200);

  return next();
}

/**
 * Guests must pass Turnstile before endpoints that cost money without using
 * a trial credit (image OCR on upload). Signed-in users pass through.
 */
export async function guestVerificationMiddleware(c: Context, next: Next) {
  if (c.get('user') || !isTurnstileEnabled()) {
    return next();
  }
  const fingerprint = guestSessionService.generateFingerprint(c);
  if (guestSessionService.isVerified(fingerprint)) {
    return next();
  }
  return c.json(guestVerificationRequired(), 401);
}

/**
 * Middleware for endpoints that require authentication
 * No guest access allowed
 */
export async function strictAuthMiddleware(c: Context, next: Next) {
  try {
    const user = await getCurrentUser(c);
    
    if (!user) {
      return c.json({
        error: 'Authentication required. Please login to access this feature.',
        code: 'AUTH_REQUIRED',
        requiresAuth: true,
        loginUrl: '/login.html'
      }, 401);
    }
    
    // Add user to context for use in controllers
    c.set('user', user);
    c.header('X-Auth-Status', 'authenticated');
    c.header('X-User-ID', user.id);
    
    return next();
    
  } catch (error) {
    console.error('Strict auth middleware error:', error);
    return c.json({ error: 'Authentication failed' }, 500);
  }
}

/**
 * Optional auth middleware - doesn't enforce limits
 * Used for endpoints where auth is optional but provides benefits
 */
export async function optionalAuthMiddleware(c: Context, next: Next) {
  try {
    const user = await getCurrentUser(c);
    
    if (user) {
      c.set('user', user);
      c.header('X-Auth-Status', 'authenticated');
      c.header('X-User-ID', user.id);
    } else {
      c.header('X-Auth-Status', 'anonymous');
    }
    
    return next();
    
  } catch (error) {
    console.error('Optional auth middleware error:', error);
    c.header('X-Auth-Status', 'error');
    return next();
  }
}

/**
 * Reset guest usage after successful login
 * Call this in login controller
 */
export function resetGuestUsage(c: Context): void {
  try {
    const fingerprint = guestSessionService.generateFingerprint(c);
    guestSessionService.resetUsage(fingerprint);
    console.log(`Reset guest usage for fingerprint: ${fingerprint}`);
  } catch (error) {
    console.error('Error resetting guest usage:', error);
  }
}