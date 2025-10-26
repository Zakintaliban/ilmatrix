import { Context } from 'hono';
import {
  createUser,
  loginUser,
  loginUserWithGuestMigration,
  getUserBySessionToken,
  logoutUser,
  updateUser,
  getUserById,
  getUserByIdWithPassword,
  verifyEmail,
  resendVerificationEmail,
  CreateUserData,
  LoginCredentials
} from '../services/authService.js';
import { guestSessionService } from '../services/guestSessionService.js';

/**
 * Register new user
 */
export async function registerUser(c: Context) {
  try {
    const body = await c.req.json();
    const { email, username, password, name, birth_date, country } = body as CreateUserData;
    
    // Basic validation
    if (!email || !username || !password || !name || !birth_date || !country) {
      return c.json({ error: 'All fields are required: email, username, password, name, birth_date, country' }, 400);
    }
    
    if (password.length < 8) {
      return c.json({ error: 'Password must be at least 8 characters long' }, 400);
    }
    
    // Validate username format (alphanumeric + underscore, 3-20 chars)
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return c.json({ error: 'Username must be 3-20 characters and contain only letters, numbers, and underscores' }, 400);
    }
    
    // Validate birth date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birth_date)) {
      return c.json({ error: 'Birth date must be in YYYY-MM-DD format' }, 400);
    }
    
    // Create user
    const user = await createUser({ email, username, password, name, birth_date, country });
    
    return c.json({ 
      message: 'User created successfully. Please check your email for verification.',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        created_at: user.created_at,
        email_verified: user.email_verified
      }
    }, 201);
    
  } catch (error) {
    console.error('Register error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('already exists')) {
        return c.json({ error: error.message }, 409);
      }
    }
    
    return c.json({ error: 'Registration failed' }, 500);
  }
}

/**
 * Login user
 */
export async function login(c: Context) {
  try {
    const body = await c.req.json();
    const { email, password } = body as LoginCredentials;

    // Basic validation
    if (!email || !password) {
      return c.json({ error: 'Email and password are required' }, 400);
    }

    // Get user agent and IP
    const userAgent = c.req.header('user-agent');
    const ipAddress = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';

    // Get guest fingerprint for migration
    const guestFingerprint = guestSessionService.generateFingerprint(c);

    // Login user with guest migration
    const { user, sessionToken, guestMigration } = await loginUserWithGuestMigration(
      { email, password },
      guestFingerprint,
      userAgent,
      Array.isArray(ipAddress) ? ipAddress[0] : ipAddress
    );

    // Set session cookie
    c.header('Set-Cookie', `session=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Max-Age=${7 * 24 * 60 * 60}; Path=/`);

    // Reset guest usage after successful login
    try {
      const { resetGuestUsage } = await import('../middleware/guestLimit.js');
      resetGuestUsage(c);
    } catch (error) {
      console.warn('Failed to reset guest usage:', error);
    }

    const response: any = {
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        last_login: user.last_login
      }
    };

    // Include guest migration info if applicable
    if (guestMigration && guestMigration.migrated > 0) {
      response.guestMigration = {
        message: `Successfully migrated ${guestMigration.migrated} guest chat session(s) to your account.`,
        migrated: guestMigration.migrated,
        errors: guestMigration.errors
      };
    }

    return c.json(response);

  } catch (error) {
    console.error('Login error:', error);

    if (error instanceof Error) {
      if (error.message.includes('Invalid email or password')) {
        return c.json({ error: 'Invalid email or password' }, 401);
      }
    }

    return c.json({ error: 'Login failed' }, 500);
  }
}

/**
 * Logout user
 */
export async function logout(c: Context) {
  try {
    const sessionToken = getSessionFromRequest(c);
    
    if (!sessionToken) {
      return c.json({ error: 'No session found' }, 401);
    }
    
    await logoutUser(sessionToken);
    
    // Clear session cookie
    c.header('Set-Cookie', 'session=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/');
    
    return c.json({ message: 'Logout successful' });
    
  } catch (error) {
    console.error('Logout error:', error);
    return c.json({ error: 'Logout failed' }, 500);
  }
}

/**
 * Get current user profile
 */
export async function getProfile(c: Context) {
  try {
    const user = c.get('user');
    
    if (!user) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    
    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        bio: user.bio,
        auth_method: user.auth_method,
        created_at: user.created_at,
        last_login: user.last_login
      }
    });
    
  } catch (error) {
    console.error('Get profile error:', error);
    return c.json({ error: 'Failed to get profile' }, 500);
  }
}

/**
 * Update user profile
 */
export async function updateProfile(c: Context) {
  try {
    const user = c.get('user');
    
    if (!user) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    
    const body = await c.req.json();
    const { name, phone, bio, email } = body;
    
    // Prepare updates - phone and bio are new fields
    const updates: { name?: string; phone?: string; bio?: string; email?: string } = {};
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (bio !== undefined) updates.bio = bio;
    if (email !== undefined) updates.email = email;
    
    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }
    
    const updatedUser = await updateUser(user.id, updates);
    
    return c.json({
      message: 'Profile updated successfully',
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        name: updatedUser.name,
        phone: updatedUser.phone,
        bio: updatedUser.bio,
        created_at: updatedUser.created_at,
        updated_at: updatedUser.updated_at
      }
    });
    
  } catch (error) {
    console.error('Update profile error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('already exists')) {
        return c.json({ error: 'Email already exists' }, 409);
      }
    }
    
    return c.json({ error: 'Failed to update profile' }, 500);
  }
}

/**
 * Change user password
 */
export async function changePassword(c: Context) {
  try {
    const user = c.get('user');
    
    if (!user) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    
    const body = await c.req.json();
    const { currentPassword, newPassword } = body;
    
    if (!currentPassword || !newPassword) {
      return c.json({ error: 'Current password and new password are required' }, 400);
    }
    
    if (newPassword.length < 8) {
      return c.json({ error: 'New password must be at least 8 characters long' }, 400);
    }
    
    // Import bcrypt for password verification
    const bcrypt = (await import('bcryptjs')).default;
    
    // Get full user data to verify current password
    const fullUser = await getUserByIdWithPassword(user.id);
    if (!fullUser) {
      return c.json({ error: 'User not found' }, 404);
    }
    
    // Verify current password
    const isValidPassword = await bcrypt.compare(currentPassword, fullUser.password);
    if (!isValidPassword) {
      return c.json({ error: 'Current password is incorrect' }, 401);
    }
    
    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, 12);
    
    // Update password
    await updateUser(user.id, { password: hashedNewPassword });
    
    return c.json({ message: 'Password updated successfully' });
    
  } catch (error) {
    console.error('Change password error:', error);
    return c.json({ error: 'Failed to update password' }, 500);
  }
}

/**
 * Delete user account
 */
export async function deleteAccount(c: Context) {
  try {
    const user = c.get('user');
    
    if (!user) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    
    // Import database service
    const { query } = await import('../services/databaseService.js');
    
    // Begin transaction to delete user and all related data
    await query('BEGIN');
    
    try {
      // Delete user sessions first
      await query('DELETE FROM user_sessions WHERE user_id = $1', [user.id]);
      
      // Delete chat sessions and messages
      await query('DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE user_id = $1)', [user.id]);
      await query('DELETE FROM chat_sessions WHERE user_id = $1', [user.id]);
      
      // Delete user materials
      await query('DELETE FROM user_materials WHERE user_id = $1', [user.id]);
      
      // Finally delete the user
      await query('DELETE FROM users WHERE id = $1', [user.id]);
      
      await query('COMMIT');
      
      // Clear session cookie
      c.header('Set-Cookie', 'session=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/');
      
      return c.json({ message: 'Account deleted successfully' });
      
    } catch (error) {
      await query('ROLLBACK');
      throw error;
    }
    
  } catch (error) {
    console.error('Delete account error:', error);
    return c.json({ error: 'Failed to delete account' }, 500);
  }
}

/**
 * Authentication middleware
 */
export async function authMiddleware(c: Context, next: () => Promise<void>) {
  try {
    const sessionToken = getSessionFromRequest(c);
    
    if (!sessionToken) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    
    const user = await getUserBySessionToken(sessionToken);
    
    if (!user) {
      return c.json({ error: 'Invalid or expired session' }, 401);
    }
    
    // Set user in context
    c.set('user', user);
    
    await next();
    
  } catch (error) {
    console.error('Auth middleware error:', error);
    return c.json({ error: 'Authentication failed' }, 500);
  }
}

/**
 * Optional authentication middleware (doesn't require auth)
 */
export async function optionalAuthMiddleware(c: Context, next: () => Promise<void>) {
  try {
    const sessionToken = getSessionFromRequest(c);
    
    if (sessionToken) {
      const user = await getUserBySessionToken(sessionToken);
      if (user) {
        c.set('user', user);
      }
    }
    
    await next();
    
  } catch (error) {
    console.error('Optional auth middleware error:', error);
    // Continue without setting user
    await next();
  }
}

/**
 * Verify email with token
 */
export async function verifyEmailController(c: Context) {
  try {
    const token = c.req.query('token');
    
    if (!token) {
      return c.json({ error: 'Verification token is required' }, 400);
    }
    
    const user = await verifyEmail(token);
    
    if (!user) {
      return c.html(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Verification Failed - ILMATRIX</title>
            <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="min-h-screen bg-gradient-to-br from-red-500 to-pink-600 flex items-center justify-center p-4">
            <div class="max-w-md w-full bg-white rounded-2xl shadow-2xl p-8 text-center">
                <div class="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
                    <svg class="w-10 h-10 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </div>
                <h1 class="text-3xl font-bold text-gray-900 mb-4">❌ Verification Failed</h1>
                <p class="text-gray-600 mb-6">The verification token is invalid or has expired. Please try again.</p>
                <a href="/login.html" class="inline-block bg-red-500 text-white font-medium py-3 px-6 rounded-lg hover:bg-red-600 transition-colors">
                    Back to Login
                </a>
            </div>
        </body>
        </html>
      `, 400);
    }
    
    // Redirect to success page
    return c.redirect('/email-verified.html');
    
  } catch (error) {
    console.error('Email verification error:', error);
    return c.json({ error: 'Email verification failed' }, 500);
  }
}

/**
 * Resend verification email
 */
export async function resendVerificationController(c: Context) {
  try {
    const body = await c.req.json();
    const { email } = body;
    
    if (!email) {
      return c.json({ error: 'Email is required' }, 400);
    }
    
    const sent = await resendVerificationEmail(email);
    
    if (sent) {
      return c.json({ message: 'Verification email sent successfully' });
    } else {
      return c.json({ message: 'Email service not configured, but user account is valid' });
    }
    
  } catch (error) {
    console.error('Resend verification error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('not found') || error.message.includes('already verified')) {
        return c.json({ error: error.message }, 400);
      }
    }
    
    return c.json({ error: 'Failed to resend verification email' }, 500);
  }
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