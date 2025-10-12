import { Context } from 'hono';
import { 
  createUser, 
  loginUser, 
  getUserBySessionToken, 
  logoutUser, 
  updateUser, 
  getUserById,
  CreateUserData,
  LoginCredentials 
} from '../services/authService.js';

/**
 * Register new user
 */
export async function registerUser(c: Context) {
  try {
    const body = await c.req.json();
    const { email, password, name } = body as CreateUserData;
    
    // Basic validation
    if (!email || !password || !name) {
      return c.json({ error: 'Email, password, and name are required' }, 400);
    }
    
    if (password.length < 8) {
      return c.json({ error: 'Password must be at least 8 characters long' }, 400);
    }
    
    // Create user
    const user = await createUser({ email, password, name });
    
    return c.json({ 
      message: 'User created successfully',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        created_at: user.created_at
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
    
    // Login user
    const { user, sessionToken } = await loginUser(
      { email, password },
      userAgent,
      Array.isArray(ipAddress) ? ipAddress[0] : ipAddress
    );
    
    // Set session cookie
    c.header('Set-Cookie', `session=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Max-Age=${7 * 24 * 60 * 60}; Path=/`);
    
    return c.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        last_login: user.last_login
      }
    });
    
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
    const { name, email } = body;
    
    // Prepare updates
    const updates: { name?: string; email?: string } = {};
    if (name) updates.name = name;
    if (email) updates.email = email;
    
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