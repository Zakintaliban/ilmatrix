import { Context } from 'hono';
import * as chatHistoryService from '../services/chatHistoryService.js';
import * as userMaterialService from '../services/userMaterialService.js';

// Helper function to get user ID from context
function getUserId(c: Context): string | null {
  const user = c.get('user');
  return user ? user.id : null;
}

/**
 * Get dashboard overview data for authenticated user
 */
export async function getDashboardOverview(c: Context) {
  try {
    const userId = getUserId(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    // Get chat statistics and material statistics in parallel
    const [chatStats, materialStats] = await Promise.all([
      chatHistoryService.getUserChatStats(userId),
      userMaterialService.getUserMaterialStats(userId)
    ]);

    // Get recent activity
    const [recentSessions, recentMaterials] = await Promise.all([
      chatHistoryService.getUserSessions(userId, { limit: 5 }),
      userMaterialService.getRecentlyAccessedMaterials(userId, 5)
    ]);

    return c.json({
      stats: {
        chat: chatStats,
        materials: materialStats
      },
      recentActivity: {
        sessions: recentSessions,
        materials: recentMaterials
      }
    });
  } catch (error) {
    console.error('Dashboard overview error:', error);
    return c.json({ error: 'Failed to load dashboard data' }, 500);
  }
}

/**
 * Get user's chat sessions with pagination
 */
export async function getChatSessions(c: Context) {
  try {
    const userId = getUserId(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');
    const includeArchived = c.req.query('includeArchived') === 'true';

    const sessions = await chatHistoryService.getUserSessions(userId, {
      limit,
      offset,
      includeArchived
    });

    return c.json({ sessions });
  } catch (error) {
    console.error('Get chat sessions error:', error);
    return c.json({ error: 'Failed to load chat sessions' }, 500);
  }
}

/**
 * Create a new chat session
 */
export async function createChatSession(c: Context) {
  try {
    const userId = getUserId(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const { title } = await c.req.json();
    if (!title?.trim()) {
      return c.json({ error: 'Session title is required' }, 400);
    }

    const session = await chatHistoryService.createSession({
      userId,
      title: title.trim()
    });

    return c.json({ session });
  } catch (error) {
    console.error('Create chat session error:', error);
    return c.json({ error: 'Failed to create chat session' }, 500);
  }
}

/**
 * Get messages for a specific chat session
 */
export async function getChatMessages(c: Context) {
  try {
    const userId = getUserId(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const sessionId = c.req.param('sessionId');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');

    const messages = await chatHistoryService.getSessionMessages(sessionId, userId, {
      limit,
      offset
    });

    return c.json({ messages });
  } catch (error) {
    console.error('Get chat messages error:', error);
    if (error instanceof Error && error.message.includes('not found')) {
      return c.json({ error: 'Chat session not found' }, 404);
    }
    return c.json({ error: 'Failed to load chat messages' }, 500);
  }
}

/**
 * Update chat session (title, archive status)
 */
export async function updateChatSession(c: Context) {
  try {
    const userId = getUserId(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const sessionId = c.req.param('sessionId');
    const updates = await c.req.json();

    const session = await chatHistoryService.updateSession(sessionId, userId, updates);
    if (!session) {
      return c.json({ error: 'Chat session not found' }, 404);
    }

    return c.json({ session });
  } catch (error) {
    console.error('Update chat session error:', error);
    return c.json({ error: 'Failed to update chat session' }, 500);
  }
}

/**
 * Delete a chat session
 */
export async function deleteChatSession(c: Context) {
  try {
    const userId = getUserId(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const sessionId = c.req.param('sessionId');
    const deleted = await chatHistoryService.deleteSession(sessionId, userId);

    if (!deleted) {
      return c.json({ error: 'Chat session not found' }, 404);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Delete chat session error:', error);
    return c.json({ error: 'Failed to delete chat session' }, 500);
  }
}

/**
 * Get user's saved materials with filtering and pagination
 */
export async function getUserMaterials(c: Context) {
  try {
    const userId = getUserId(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');
    const sortBy = c.req.query('sortBy') as any || 'created_at';
    const sortOrder = c.req.query('sortOrder') as any || 'desc';
    const searchQuery = c.req.query('search');
    const favoritesOnly = c.req.query('favoritesOnly') === 'true';
    const tagsParam = c.req.query('tags');
    const tags = tagsParam ? tagsParam.split(',').map(t => t.trim()) : undefined;

    const materials = await userMaterialService.getUserMaterials(userId, {
      limit,
      offset,
      sortBy,
      sortOrder,
      searchQuery,
      favoritesOnly,
      tags
    });

    return c.json({ materials });
  } catch (error) {
    console.error('Get user materials error:', error);
    return c.json({ error: 'Failed to load materials' }, 500);
  }
}

/**
 * Save a material to user's collection
 */
export async function saveMaterial(c: Context) {
  try {
    const userId = getUserId(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const { materialId, title, description, fileNames, fileTypes, tags } = await c.req.json();

    if (!materialId || !title || !fileNames || !fileTypes) {
      return c.json({ 
        error: 'materialId, title, fileNames, and fileTypes are required' 
      }, 400);
    }

    // Check if material is already saved
    const alreadySaved = await userMaterialService.isMaterialSaved(materialId, userId);
    if (alreadySaved) {
      return c.json({ error: 'Material is already saved' }, 409);
    }

    const savedMaterial = await userMaterialService.saveUserMaterial({
      userId,
      materialId,
      title,
      description,
      fileNames,
      fileTypes,
      tags
    });

    return c.json({ material: savedMaterial });
  } catch (error) {
    console.error('Save material error:', error);
    return c.json({ error: 'Failed to save material' }, 500);
  }
}

/**
 * Update a saved material's metadata
 */
export async function updateSavedMaterial(c: Context) {
  try {
    const userId = getUserId(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const materialId = c.req.param('materialId');
    const updates = await c.req.json();

    const material = await userMaterialService.updateUserMaterial(materialId, userId, updates);
    if (!material) {
      return c.json({ error: 'Saved material not found' }, 404);
    }

    return c.json({ material });
  } catch (error) {
    console.error('Update saved material error:', error);
    return c.json({ error: 'Failed to update material' }, 500);
  }
}

/**
 * Delete a saved material
 */
export async function deleteSavedMaterial(c: Context) {
  try {
    const userId = getUserId(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const materialId = c.req.param('materialId');
    const deleted = await userMaterialService.deleteUserMaterial(materialId, userId);

    if (!deleted) {
      return c.json({ error: 'Saved material not found' }, 404);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Delete saved material error:', error);
    return c.json({ error: 'Failed to delete material' }, 500);
  }
}

/**
 * Record access to a material (for analytics)
 */
export async function recordMaterialAccess(c: Context) {
  try {
    const userId = getUserId(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const materialId = c.req.param('materialId');
    await userMaterialService.recordMaterialAccess(materialId, userId);

    return c.json({ success: true });
  } catch (error) {
    console.error('Record material access error:', error);
    return c.json({ error: 'Failed to record access' }, 500);
  }
}

/**
 * Get user's tags for filtering
 */
export async function getUserTags(c: Context) {
  try {
    const userId = getUserId(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const tags = await userMaterialService.getUserTags(userId);
    return c.json({ tags });
  } catch (error) {
    console.error('Get user tags error:', error);
    return c.json({ error: 'Failed to load tags' }, 500);
  }
}

/**
 * Get materials by specific tag
 */
export async function getMaterialsByTag(c: Context) {
  try {
    const userId = getUserId(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const tag = c.req.param('tag');
    const materials = await userMaterialService.getMaterialsByTag(userId, tag);

    return c.json({ materials, tag });
  } catch (error) {
    console.error('Get materials by tag error:', error);
    return c.json({ error: 'Failed to load materials' }, 500);
  }
}

/**
 * Generate smart title for chat session based on messages
 */
export async function generateSessionTitle(c: Context) {
  try {
    const userId = getUserId(c);
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const sessionId = c.req.param('sessionId');
    const title = await chatHistoryService.generateSessionTitle(sessionId, userId);

    // Update the session with the generated title
    const session = await chatHistoryService.updateSession(sessionId, userId, { title });
    if (!session) {
      return c.json({ error: 'Chat session not found' }, 404);
    }

    return c.json({ title, session });
  } catch (error) {
    console.error('Generate session title error:', error);
    return c.json({ error: 'Failed to generate title' }, 500);
  }
}