import { Context } from 'hono';
import { generateGoogleAuthUrl, processGoogleAuth, isGoogleOAuthConfigured } from '../services/googleOAuthService.js';

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

    // Generate Google OAuth URL and redirect
    const authUrl = generateGoogleAuthUrl();
    return c.redirect(authUrl);
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
    
    // Handle OAuth errors (user cancelled, etc.)
    if (error) {
      console.log('OAuth error:', error);
      return c.redirect('/login.html?error=oauth_cancelled');
    }
    
    if (!code) {
      return c.redirect('/login.html?error=oauth_failed');
    }

    // Get user agent and IP address for session tracking
    const userAgent = c.req.header('User-Agent');
    const ipAddress = c.req.header('x-forwarded-for') || 
                     c.req.header('x-real-ip') || 
                     c.env?.ip || 
                     'unknown';

    // Process Google OAuth (exchange code for tokens, get user info, create/login user)
    const { user, sessionToken, isNewUser } = await processGoogleAuth(
      code, 
      userAgent, 
      Array.isArray(ipAddress) ? ipAddress[0] : ipAddress
    );

    // Set session cookie (Secure only in production)
    const isProduction = process.env.NODE_ENV === 'production';
    const secureFlag = isProduction ? ' Secure;' : '';
    const cookieValue = `session=${sessionToken}; HttpOnly;${secureFlag} SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`;

    console.log(`[OAuth] Setting cookie (production: ${isProduction}): ${cookieValue}`);
    console.log(`[OAuth] User created/logged in:`, { 
      id: user.id, 
      email: user.email, 
      name: user.name, 
      auth_method: user.auth_method,
      isNewUser 
    });
    console.log(`[OAuth] Session token:`, sessionToken);
    
    c.header('Set-Cookie', cookieValue);

    // Redirect to dashboard with success message
    const redirectUrl = isNewUser 
      ? '/dashboard.html?welcome=true&oauth=google'
      : '/dashboard.html?login=success&oauth=google';
    
    return c.redirect(redirectUrl);
  } catch (error) {
    console.error('Google OAuth callback error:', error);
    
    // Redirect with specific error message
    const errorMessage = error instanceof Error ? error.message : 'oauth_failed';
    return c.redirect(`/login.html?error=${encodeURIComponent(errorMessage)}`);
  }
}