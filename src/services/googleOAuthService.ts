import { config } from '../config/env.js';
import { createSession } from './authService.js';
import { query, transaction } from './databaseService.js';

export interface GoogleUserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name: string;
  family_name: string;
  picture: string;
  locale: string;
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

/**
 * Generate Google OAuth authorization URL. `state` is a random value also kept
 * in a cookie; the callback only proceeds when both match (login CSRF).
 */
export function generateGoogleAuthUrl(state: string): string {
  if (!config.googleClientId) {
    throw new Error('Google OAuth is not configured');
  }

  const baseUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    // Sign-in only: no refresh token needed
    prompt: 'select_account'
  });

  return `${baseUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 */
export async function exchangeCodeForTokens(code: string): Promise<GoogleTokenResponse> {
  if (!config.googleClientId || !config.googleClientSecret) {
    throw new Error('Google OAuth is not configured');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.googleRedirectUri,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to exchange code for tokens: ${error}`);
  }

  return await response.json();
}

/**
 * Get user information from Google
 */
export async function getGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get user info: ${error}`);
  }

  return await response.json();
}

/**
 * Get user by email
 */
async function getUserByEmail(email: string) {
  const result = await query(
    'SELECT id, email, username, name, birth_date, country, phone, bio, email_verified, auth_method, created_at, updated_at, is_active, last_login FROM users WHERE email = $1 AND is_active = true',
    [email.toLowerCase()]
  );
  
  return result.rows[0] || null;
}

/**
 * Create OAuth user (Google user without password)
 */
async function createOAuthUser(googleUser: GoogleUserInfo) {
  // Generate unique username from Google ID
  const username = `google_${googleUser.id}`;
  
  // Create user in database (password_hash is now nullable for OAuth users)
  const result = await query(
    `INSERT INTO users (email, username, name, birth_date, country, email_verified, auth_method, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, email, username, name, birth_date, country, phone, bio, email_verified, auth_method, created_at, updated_at, is_active, last_login`,
    [
      googleUser.email.toLowerCase(),
      username,
      googleUser.name,
      '2000-01-01', // Default birth date for OAuth users
      'Unknown', // Default country
      true, // Google emails are already verified
      'google', // Authentication method
      true // Active by default
    ]
  );
  
  return result.rows[0];
}

/**
 * Create OAuth session for user
 */
async function createOAuthSession(userId: string, userAgent?: string, ipAddress?: string) {
  const sessionToken = await createSession({ query }, userId, userAgent, ipAddress);
  await query('UPDATE users SET last_login = NOW() WHERE id = $1', [userId]);
  return sessionToken;
}

/**
 * Google has proved this person owns the email, but an unverified password
 * account already uses it. Whoever created that account never proved they own
 * the inbox and may be an attacker waiting for the real owner to sign in
 * (account pre-hijacking). The Google user takes the account over: its
 * password and every existing session are removed and the email is marked
 * verified, so only Google sign-in (or a new password) can get in afterwards.
 */
async function claimUnverifiedAccount(userId: string) {
  return transaction(async (client) => {
    await client.query('DELETE FROM user_sessions WHERE user_id = $1', [userId]);
    const result = await client.query(
      `UPDATE users
       SET email_verified = true, password_hash = NULL, auth_method = 'google',
           email_verification_token = NULL, email_verification_expires = NULL, updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, username, name, birth_date, country, phone, bio, email_verified, auth_method, created_at, updated_at, is_active, last_login`,
      [userId]
    );
    return result.rows[0];
  });
}

/**
 * Process Google OAuth login/registration
 */
export async function processGoogleAuth(code: string, userAgent?: string, ipAddress?: string) {
  try {
    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code);
    
    // Get user info from Google
    const googleUser = await getGoogleUserInfo(tokens.access_token);
    
    if (!googleUser.verified_email) {
      throw new Error('Google account email is not verified');
    }

    // Check if user already exists
    let user = await getUserByEmail(googleUser.email);

    if (user && !user.email_verified) {
      console.warn(`[OAuth] Google sign-in took over unverified account ${user.id}; its password and sessions were removed`);
      user = await claimUnverifiedAccount(user.id);
    }
    
    if (user) {
      // User exists, create session for them
      const sessionToken = await createOAuthSession(user.id, userAgent, ipAddress);
      return { user, sessionToken, isNewUser: false };
    } else {
      // User doesn't exist, create new account
      const newUser = await createOAuthUser(googleUser);
      
      // Create session for new user
      const sessionToken = await createOAuthSession(newUser.id, userAgent, ipAddress);
      
      return { user: newUser, sessionToken, isNewUser: true };
    }
  } catch (error) {
    console.error('Google OAuth processing error:', error);
    throw error;
  }
}

/**
 * Check if Google OAuth is configured
 */
export function isGoogleOAuthConfigured(): boolean {
  return !!(config.googleClientId && config.googleClientSecret);
}