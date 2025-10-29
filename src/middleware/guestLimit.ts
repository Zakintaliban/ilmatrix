import { Context, Next } from 'hono';
import { guestSessionService } from '../services/guestSessionService.js';
import { getUserBySessionToken } from '../services/authService.js';
import { behaviorAnalysisService } from '../services/behaviorAnalysisService.js';

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
  let deviceId: string | undefined;

  try {
    // First check if user is authenticated
    const user = await getCurrentUser(c);

    if (user) {
      // Authenticated user: unlimited access
      console.log(`Authenticated user ${user.email} accessing AI feature`);

      // Add auth status headers for frontend
      c.header('X-Auth-Status', 'authenticated');
      c.header('X-User-ID', user.id);

      return next();
    }

    // Guest user: check usage limits
    const fingerprint = guestSessionService.generateFingerprint(c);
    deviceId = fingerprint; // Store for behavioral tracking

    // Check if device is flagged as suspicious
    if (behaviorAnalysisService.isSuspicious(deviceId)) {
      console.warn(`⚠️  Suspicious device ${deviceId.substring(0, 8)}... attempting access`);
      c.header('X-Suspicious-Activity', 'true');
    }

    // Check if already at limit
    if (guestSessionService.isLimitReached(fingerprint)) {
      console.log(`Guest ${fingerprint} reached usage limit`);

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

    console.log(`Guest ${fingerprint} usage: ${usageResult.newCount}/5 (${usageResult.remaining} remaining)`);

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

  } catch (error) {
    console.error('Guest limit middleware error:', error);

    // Track error for behavioral analysis
    if (deviceId) {
      behaviorAnalysisService.trackRequest(deviceId, c, endpoint, 500);
    }

    // On error, allow the request but log it
    c.header('X-Auth-Status', 'error');
    return next();
  }
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