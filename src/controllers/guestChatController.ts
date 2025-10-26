import { Context } from 'hono';
import * as guestChatService from '../services/guestChatService.js';
import { guestSessionService } from '../services/guestSessionService.js';

/**
 * Helper function to get guest fingerprint from context
 */
function getGuestFingerprint(c: Context): string {
  return guestSessionService.generateFingerprint(c);
}

/**
 * Get guest chat sessions for current guest
 */
export async function getGuestChatSessions(c: Context) {
  try {
    const guestFingerprint = getGuestFingerprint(c);
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');
    const includeMigrated = c.req.query('includeMigrated') === 'true';

    const sessions = await guestChatService.getGuestSessions(guestFingerprint, {
      limit,
      offset,
      includeMigrated
    });

    return c.json({ sessions });
  } catch (error) {
    console.error('Get guest chat sessions error:', error);
    return c.json({ error: 'Failed to load guest chat sessions' }, 500);
  }
}

/**
 * Create a new guest chat session
 */
export async function createGuestChatSession(c: Context) {
  try {
    const guestFingerprint = getGuestFingerprint(c);
    const { title, firstMessage, endpoint } = await c.req.json();

    let sessionTitle = title;

    // Auto-generate title if not provided and first message is available
    if (!sessionTitle && firstMessage) {
      sessionTitle = guestChatService.createGuestSessionWithAutoTitle(
        guestFingerprint,
        firstMessage,
        endpoint
      ).then(s => s.title).catch(() => firstMessage.substring(0, 50));
    }

    if (!sessionTitle?.trim()) {
      return c.json({ error: 'Session title is required' }, 400);
    }

    const session = await guestChatService.createGuestSession({
      guestFingerprint,
      title: sessionTitle.trim()
    });

    return c.json({ session });
  } catch (error) {
    console.error('Create guest chat session error:', error);
    return c.json({ error: 'Failed to create guest chat session' }, 500);
  }
}

/**
 * Get messages for a specific guest chat session
 */
export async function getGuestChatMessages(c: Context) {
  try {
    const guestFingerprint = getGuestFingerprint(c);
    const sessionId = c.req.param('sessionId');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');

    const messages = await guestChatService.getGuestSessionMessages(sessionId, guestFingerprint, {
      limit,
      offset
    });

    return c.json({ messages });
  } catch (error) {
    console.error('Get guest chat messages error:', error);
    if (error instanceof Error && error.message.includes('not found')) {
      return c.json({ error: 'Guest chat session not found or expired' }, 404);
    }
    return c.json({ error: 'Failed to load guest chat messages' }, 500);
  }
}

/**
 * Add a message to a specific guest chat session
 */
export async function addGuestChatMessage(c: Context) {
  try {
    const guestFingerprint = getGuestFingerprint(c);
    const sessionId = c.req.param('sessionId');
    const { role, content, materialId, endpoint, tokensUsed } = await c.req.json();

    if (!role || !content) {
      return c.json({ error: 'Role and content are required' }, 400);
    }

    if (!['user', 'assistant'].includes(role)) {
      return c.json({ error: 'Role must be either "user" or "assistant"' }, 400);
    }

    const message = await guestChatService.addGuestMessage({
      sessionId,
      role: role as 'user' | 'assistant',
      content,
      materialId,
      endpoint,
      tokensUsed
    });

    // Auto-generate title if this is the first message and no title was set
    if (role === 'user') {
      try {
        const session = await guestChatService.getGuestSession(sessionId, guestFingerprint);
        if (session && session.messageCount === 1) {
          // This is the first message, generate title
          const title = await guestChatService.generateGuestSessionTitle(sessionId, guestFingerprint);
          if (title !== session.title) {
            await guestChatService.updateGuestSession(sessionId, guestFingerprint, { title });
          }
        }
      } catch (titleError) {
        console.error('Auto-title generation error:', titleError);
        // Don't fail the request if title generation fails
      }
    }

    return c.json({ message });
  } catch (error) {
    console.error('Add guest chat message error:', error);
    if (error instanceof Error && error.message.includes('not found')) {
      return c.json({ error: 'Guest chat session not found or expired' }, 404);
    }
    return c.json({ error: 'Failed to add message' }, 500);
  }
}

/**
 * Update guest chat session (title)
 */
export async function updateGuestChatSession(c: Context) {
  try {
    const guestFingerprint = getGuestFingerprint(c);
    const sessionId = c.req.param('sessionId');
    const updates = await c.req.json();

    const session = await guestChatService.updateGuestSession(sessionId, guestFingerprint, updates);
    if (!session) {
      return c.json({ error: 'Guest chat session not found or expired' }, 404);
    }

    return c.json({ session });
  } catch (error) {
    console.error('Update guest chat session error:', error);
    return c.json({ error: 'Failed to update guest chat session' }, 500);
  }
}

/**
 * Delete a guest chat session
 */
export async function deleteGuestChatSession(c: Context) {
  try {
    const guestFingerprint = getGuestFingerprint(c);
    const sessionId = c.req.param('sessionId');

    const deleted = await guestChatService.deleteGuestSession(sessionId, guestFingerprint);
    if (!deleted) {
      return c.json({ error: 'Guest chat session not found or expired' }, 404);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Delete guest chat session error:', error);
    return c.json({ error: 'Failed to delete guest chat session' }, 500);
  }
}

/**
 * Generate smart title for guest chat session based on messages
 */
export async function generateGuestSessionTitle(c: Context) {
  try {
    const guestFingerprint = getGuestFingerprint(c);
    const sessionId = c.req.param('sessionId');

    const title = await guestChatService.generateGuestSessionTitle(sessionId, guestFingerprint);

    // Update the session with the generated title
    const session = await guestChatService.updateGuestSession(sessionId, guestFingerprint, { title });
    if (!session) {
      return c.json({ error: 'Guest chat session not found or expired' }, 404);
    }

    return c.json({ title, session });
  } catch (error) {
    console.error('Generate guest session title error:', error);
    return c.json({ error: 'Failed to generate title' }, 500);
  }
}

/**
 * Get guest chat statistics
 */
export async function getGuestChatStats(c: Context) {
  try {
    const guestFingerprint = getGuestFingerprint(c);

    const stats = await guestChatService.getGuestChatStats(guestFingerprint);
    return c.json({ stats });
  } catch (error) {
    console.error('Get guest chat stats error:', error);
    return c.json({ error: 'Failed to load guest chat statistics' }, 500);
  }
}

/**
 * Get pending migrations for current guest (to be called after login)
 */
export async function getPendingMigrations(c: Context) {
  try {
    const guestFingerprint = getGuestFingerprint(c);

    const sessions = await guestChatService.getPendingMigrations(guestFingerprint);
    return c.json({ sessions });
  } catch (error) {
    console.error('Get pending migrations error:', error);
    return c.json({ error: 'Failed to load pending migrations' }, 500);
  }
}

/**
 * Migrate guest chat sessions to authenticated user
 */
export async function migrateGuestChats(c: Context) {
  try {
    const userId = c.get('user')?.id;
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const guestFingerprint = getGuestFingerprint(c);
    const { sessionIds } = await c.req.json();

    const result = await guestChatService.migrateGuestChatsToUser(guestFingerprint, userId, sessionIds);

    // Reset guest usage after successful migration
    if (result.migrated > 0) {
      guestSessionService.resetUsage(guestFingerprint);
    }

    return c.json({
      success: true,
      migrated: result.migrated,
      errors: result.errors
    });
  } catch (error) {
    console.error('Migrate guest chats error:', error);
    return c.json({ error: 'Failed to migrate guest chats' }, 500);
  }
}

/**
 * Clean up expired guest sessions (admin endpoint)
 */
export async function cleanupExpiredGuestSessions(c: Context) {
  try {
    const cleaned = await guestChatService.cleanupExpiredGuestSessions();
    return c.json({ success: true, cleaned });
  } catch (error) {
    console.error('Cleanup expired guest sessions error:', error);
    return c.json({ error: 'Failed to cleanup expired sessions' }, 500);
  }
}