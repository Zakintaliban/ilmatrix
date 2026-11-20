import { Context } from 'hono';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getCookie } from 'hono/cookie';
import { generateGoogleAuthUrl, processGoogleAuth, isGoogleOAuthConfigured } from '../services/googleOAuthService.js';
import { getClientIp } from '../utils/security.js';

const STATE_COOKIE = 'oauth_state';
const STATE_MAX_AGE = 10 * 60; // seconds to complete the Google sign-in

function stateCookie(value: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  // Lax: sent on the top-level redirect back from Google, not on cross-site subrequests
  return `${STATE_COOKIE}=${value}; HttpOnly;${secure} SameSite=Lax; Path=/api/auth/google; Max-Age=${maxAge}`;
}

function sameState(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Initiate Google OAuth login
 */
export async function initiateGoogleAuth(c: Context) {
  try {
    // Check if Google OAuth is configured
    if (!isGoogleOAuthConfigured()) {
      return c.json({ 
        error: 'Google OAuth is not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.',
        redirect: false 
      }, 501);
    }

    // Generate Google OAuth URL and redirect; the state ties the callback to this browser
    const state = randomBytes(32).toString('hex');
    c.header('Set-Cookie', stateCookie(state, STATE_MAX_AGE));
    return c.redirect(generateGoogleAuthUrl(state));
  } catch (error) {
    console.error('Google OAuth initiation error:', error);
    return c.json({ error: 'Failed to initiate Google authentication' }, 500);
  }
}

/**
 * Handle Google OAuth callback
 */
export async function handleGoogleCallback(c: Context) {
  try {
    const code = c.req.query('code');
    const error = c.req.query('error');
    const expectedState = getCookie(c, STATE_COOKIE);
    // Single use
    c.header('Set-Cookie', stateCookie('', 0), { append: true });
    
    // Handle OAuth errors (user cancelled, etc.)
    if (error) {
      return c.redirect('/login.html?error=oauth_cancelled');
    }

    // A callback this browser didn't start (e.g. an attacker's code to sign the
    // victim into the attacker's account) has no matching state cookie
    if (!sameState(c.req.query('state'), expectedState)) {
      return c.redirect('/login.html?error=oauth_state');
    }
    
    if (!code) {
      return c.redirect('/login.html?error=oauth_failed');
    }

    // Get user agent and IP address for session tracking
    const userAgent = c.req.header('User-Agent');
    const ipAddress = getClientIp(c);

    // Process Google OAuth (exchange code for tokens, get user info, create/login user)
    const { user, sessionToken, isNewUser } = await processGoogleAuth(code, userAgent, ipAddress);

    // Set session cookie (Secure only in production)
    const isProduction = process.env.NODE_ENV === 'production';
    const secureFlag = isProduction ? ' Secure;' : '';
    const cookieValue = `session=${sessionToken}; HttpOnly;${secureFlag} SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`;

    console.log(`[OAuth] Google sign-in: user ${user.id}${isNewUser ? ' (new)' : ''}`);
    
    c.header('Set-Cookie', cookieValue, { append: true });

    // Redirect to dashboard with success message
    const redirectUrl = isNewUser 
      ? '/dashboard.html?welcome=true&oauth=google'
      : '/dashboard.html?login=success&oauth=google';
    
    return c.redirect(redirectUrl);
  } catch (error) {
    console.error('Google OAuth callback error:', error);
    
    // Fixed codes only: provider error text stays in the server log
    const unverified = error instanceof Error && /not verified/i.test(error.message);
    return c.redirect(`/login.html?error=${unverified ? 'oauth_unverified_email' : 'oauth_failed'}`);
  }
}