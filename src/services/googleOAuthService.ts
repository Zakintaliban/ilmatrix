import { config } from '../config/env.js';
import { createUser, loginUser, generateSessionToken } from './authService.js';
import { query } from './databaseService.js';

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
 * Generate Google OAuth authorization URL
 */
export function generateGoogleAuthUrl(): string {
  if (!config.googleClientId) {
    throw new Error('Google OAuth is not configured');
  }

  const baseUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent'
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
    'SELECT id, email, username, name, birth_date, country, phone, bio, email_verified, created_at, updated_at, is_active, last_login FROM users WHERE email = $1 AND is_active = true',
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
    `INSERT INTO users (email, username, name, birth_date, country, email_verified, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, email, username, name, birth_date, country, phone, bio, email_verified, created_at, updated_at, is_active, last_login`,
    [
      googleUser.email.toLowerCase(),
      username,
      googleUser.name,
      '2000-01-01', // Default birth date for OAuth users
      'Unknown', // Default country
      true, // Google emails are already verified
      true // Active by default
    ]
  );
  
  return result.rows[0];
}

/**
 * Create OAuth session for user
 */
async function createOAuthSession(userId: string, userAgent?: string, ipAddress?: string) {
  const sessionToken = generateSessionToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // Session expires in 7 days
  
  // Handle IP address - only store if it's a valid IP, otherwise null
  const isValidIP = (ip: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || /^[0-9a-fA-F:]+$/.test(ip);
  const validIpAddress = ipAddress && ipAddress !== 'unknown' && isValidIP(ipAddress) ? ipAddress : null;
  
  await query(
    `INSERT INTO user_sessions (user_id, session_token, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, sessionToken, expiresAt, userAgent || null, validIpAddress]
  );
  
  // Update last login
  await query(
    'UPDATE users SET last_login = NOW() WHERE id = $1',
    [userId]
  );
  
  return sessionToken;
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