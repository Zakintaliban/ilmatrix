import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query, transaction } from './databaseService.js';
import { sendVerificationEmail, sendWelcomeEmail, isEmailServiceConfigured } from './emailService.js';

export interface User {
  id: string;
  email: string;
  username?: string;
  name: string;
  birth_date?: Date;
  country?: string;
  email_verified: boolean;
  created_at: Date;
  updated_at: Date;
  is_active: boolean;
  last_login?: Date;
}

export interface UserSession {
  id: string;
  user_id: string;
  session_token: string;
  expires_at: Date;
  created_at: Date;
  user_agent?: string;
  ip_address?: string;
}

export interface CreateUserData {
  email: string;
  username: string;
  password: string;
  name: string;
  birth_date: string; // YYYY-MM-DD format
  country: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

/**
 * Hash password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}

/**
 * Verify password against hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generate secure session token
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create new user
 */
export async function createUser(userData: CreateUserData): Promise<User> {
  const { email, username, password, name, birth_date, country } = userData;
  
  // Check if user already exists (email or username)
  const existingUser = await query<User>(
    'SELECT id FROM users WHERE email = $1 OR username = $2',
    [email.toLowerCase(), username.toLowerCase()]
  );
  
  if (existingUser.rows.length > 0) {
    throw new Error('User with this email or username already exists');
  }
  
  // Hash password
  const passwordHash = await hashPassword(password);
  
  // Generate email verification token
  const emailVerificationToken = crypto.randomBytes(32).toString('hex');
  const emailVerificationExpires = new Date();
  emailVerificationExpires.setHours(emailVerificationExpires.getHours() + 24); // 24 hours
  
  // Create user
  const result = await query<User>(
    `INSERT INTO users (email, username, password_hash, name, birth_date, country, email_verification_token, email_verification_expires)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, email, username, name, birth_date, country, email_verified, created_at, updated_at, is_active, last_login`,
    [email.toLowerCase(), username.toLowerCase(), passwordHash, name, birth_date, country, emailVerificationToken, emailVerificationExpires]
  );
  
  const user = result.rows[0];
  
  // Send verification email if email service is configured
  if (isEmailServiceConfigured()) {
    try {
      await sendVerificationEmail({
        email: user.email,
        name: user.name,
        token: emailVerificationToken
      });
    } catch (error) {
      console.error('Failed to send verification email:', error);
      // Don't fail registration if email fails
    }
  }
  
  return user;
}

/**
 * Authenticate user and create session
 */
export async function loginUser(
  credentials: LoginCredentials,
  userAgent?: string,
  ipAddress?: string
): Promise<{ user: User; sessionToken: string }> {
  const { email, password } = credentials;
  
  return transaction(async (client) => {
    // Get user with password hash
    const userResult = await client.query(
      'SELECT * FROM users WHERE email = $1 AND is_active = true',
      [email.toLowerCase()]
    );
    
    if (userResult.rows.length === 0) {
      throw new Error('Invalid email or password');
    }
    
    const userWithPassword = userResult.rows[0];
    
    // Verify password
    const passwordValid = await verifyPassword(password, userWithPassword.password_hash);
    if (!passwordValid) {
      throw new Error('Invalid email or password');
    }
    
    // Update last login
    const userUpdateResult = await client.query(
      `UPDATE users 
       SET last_login = NOW()
       WHERE id = $1
       RETURNING id, email, username, name, birth_date, country, email_verified, created_at, updated_at, is_active, last_login`,
      [userWithPassword.id]
    );
    
    const user = userUpdateResult.rows[0];
    
    // Create session
    const sessionToken = generateSessionToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // Session expires in 7 days
    
    await client.query(
      `INSERT INTO user_sessions (user_id, session_token, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, sessionToken, expiresAt, userAgent || null, ipAddress || null]
    );
    
    return { user, sessionToken };
  });
}

/**
 * Get user by session token
 */
export async function getUserBySessionToken(sessionToken: string): Promise<User | null> {
  const result = await query<User & { session_expires_at: Date }>(
    `SELECT u.id, u.email, u.username, u.name, u.birth_date, u.country, u.email_verified, u.created_at, u.updated_at, u.is_active, u.last_login,
            s.expires_at as session_expires_at
     FROM users u
     JOIN user_sessions s ON u.id = s.user_id
     WHERE s.session_token = $1 AND s.expires_at > NOW() AND u.is_active = true`,
    [sessionToken]
  );
  
  if (result.rows.length === 0) {
    return null;
  }
  
  const { session_expires_at, ...user } = result.rows[0];
  return user;
}

/**
 * Logout user (invalidate session)
 */
export async function logoutUser(sessionToken: string): Promise<boolean> {
  const result = await query(
    'DELETE FROM user_sessions WHERE session_token = $1',
    [sessionToken]
  );
  
  return result.rowCount > 0;
}

/**
 * Logout all sessions for a user
 */
export async function logoutAllSessions(userId: string): Promise<number> {
  const result = await query(
    'DELETE FROM user_sessions WHERE user_id = $1',
    [userId]
  );
  
  return result.rowCount;
}

/**
 * Clean up expired sessions
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const result = await query(
    'DELETE FROM user_sessions WHERE expires_at <= NOW()'
  );
  
  return result.rowCount;
}

/**
 * Get user by ID
 */
export async function getUserById(userId: string): Promise<User | null> {
  const result = await query<User>(
    'SELECT id, email, username, name, birth_date, country, email_verified, created_at, updated_at, is_active, last_login FROM users WHERE id = $1 AND is_active = true',
    [userId]
  );
  
  return result.rows[0] || null;
}

/**
 * Update user information
 */
export async function updateUser(userId: string, updates: Partial<Pick<User, 'name' | 'email'>>): Promise<User> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;
  
  if (updates.name !== undefined) {
    fields.push(`name = $${paramIndex++}`);
    values.push(updates.name);
  }
  
  if (updates.email !== undefined) {
    fields.push(`email = $${paramIndex++}`);
    values.push(updates.email.toLowerCase());
  }
  
  if (fields.length === 0) {
    throw new Error('No fields to update');
  }
  
  values.push(userId);
  
  const result = await query<User>(
    `UPDATE users 
     SET ${fields.join(', ')}
     WHERE id = $${paramIndex} AND is_active = true
     RETURNING id, email, username, name, birth_date, country, email_verified, created_at, updated_at, is_active, last_login`,
    values
  );
  
  if (result.rows.length === 0) {
    throw new Error('User not found');
  }
  
  return result.rows[0];
}

/**
 * Verify email with token
 */
export async function verifyEmail(token: string): Promise<User | null> {
  return transaction(async (client) => {
    // Find user with valid verification token
    const userResult = await client.query(
      `SELECT * FROM users 
       WHERE email_verification_token = $1 
       AND email_verification_expires > NOW() 
       AND email_verified = false
       AND is_active = true`,
      [token]
    );
    
    if (userResult.rows.length === 0) {
      return null;
    }
    
    const user = userResult.rows[0];
    
    // Update user as verified
    const updatedResult = await client.query(
      `UPDATE users 
       SET email_verified = true, 
           email_verification_token = NULL,
           email_verification_expires = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, username, name, birth_date, country, email_verified, created_at, updated_at, is_active, last_login`,
      [user.id]
    );
    
    const verifiedUser = updatedResult.rows[0];
    
    // Send welcome email
    if (isEmailServiceConfigured()) {
      try {
        await sendWelcomeEmail({
          email: verifiedUser.email,
          name: verifiedUser.name
        });
      } catch (error) {
        console.error('Failed to send welcome email:', error);
        // Don't fail verification if welcome email fails
      }
    }
    
    return verifiedUser;
  });
}

/**
 * Resend verification email
 */
export async function resendVerificationEmail(email: string): Promise<boolean> {
  const result = await query<User & { email_verification_token: string }>(
    `SELECT id, email, name, email_verification_token, email_verified 
     FROM users 
     WHERE email = $1 AND is_active = true`,
    [email.toLowerCase()]
  );
  
  if (result.rows.length === 0) {
    throw new Error('User not found');
  }
  
  const user = result.rows[0];
  
  if (user.email_verified) {
    throw new Error('Email is already verified');
  }
  
  // Generate new token if needed
  let token = user.email_verification_token;
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    const expires = new Date();
    expires.setHours(expires.getHours() + 24);
    
    await query(
      `UPDATE users 
       SET email_verification_token = $1, email_verification_expires = $2
       WHERE id = $3`,
      [token, expires, user.id]
    );
  }
  
  // Send verification email
  if (isEmailServiceConfigured()) {
    return await sendVerificationEmail({
      email: user.email,
      name: user.name,
      token
    });
  }
  
  return false;
}