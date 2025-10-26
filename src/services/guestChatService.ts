import { query as dbQuery } from './databaseService.js';
import { generateSessionTitle } from './chatHistoryService.js';

export interface GuestChatSession {
  id: string;
  guestFingerprint: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  messageCount: number;
  isMigrated: boolean;
  migratedToUserId?: string;
  expiresAt: Date;
}

export interface GuestChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  materialId?: string;
  endpoint?: string;
  createdAt: Date;
  tokensUsed: number;
}

export interface CreateGuestSessionInput {
  guestFingerprint: string;
  title: string;
}

export interface CreateGuestMessageInput {
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  materialId?: string;
  endpoint?: string;
  tokensUsed?: number;
}

export interface SessionWithRecentMessage extends GuestChatSession {
  lastMessage?: string;
  lastMessageRole?: 'user' | 'assistant';
}

/**
 * Create a new guest chat session
 */
export async function createGuestSession(input: CreateGuestSessionInput): Promise<GuestChatSession> {
  const queryText = `
    INSERT INTO guest_chat_sessions (guest_fingerprint, title)
    VALUES ($1, $2)
    RETURNING id, guest_fingerprint as "guestFingerprint", title, created_at as "createdAt",
               updated_at as "updatedAt", last_message_at as "lastMessageAt",
               message_count as "messageCount", is_migrated as "isMigrated",
               migrated_to_user_id as "migratedToUserId", expires_at as "expiresAt"
  `;

  const result = await dbQuery(queryText, [input.guestFingerprint, input.title]);
  return result.rows[0];
}

/**
 * Get all guest chat sessions for a fingerprint with pagination
 */
export async function getGuestSessions(
  guestFingerprint: string,
  options: { limit?: number; offset?: number; includeMigrated?: boolean } = {}
): Promise<SessionWithRecentMessage[]> {
  const { limit = 20, offset = 0, includeMigrated = false } = options;

  const queryText = `
    SELECT
      s.id, s.guest_fingerprint as "guestFingerprint", s.title, s.created_at as "createdAt",
      s.updated_at as "updatedAt", s.last_message_at as "lastMessageAt",
      s.message_count as "messageCount", s.is_migrated as "isMigrated",
      s.migrated_to_user_id as "migratedToUserId", s.expires_at as "expiresAt",
      m.content as "lastMessage", m.role as "lastMessageRole"
    FROM guest_chat_sessions s
    LEFT JOIN LATERAL (
      SELECT content, role FROM guest_chat_messages
      WHERE session_id = s.id
      ORDER BY created_at DESC
      LIMIT 1
    ) m ON true
    WHERE s.guest_fingerprint = $1
      ${includeMigrated ? '' : 'AND s.is_migrated = FALSE'}
      AND s.expires_at > NOW()
    ORDER BY s.last_message_at DESC
    LIMIT $2 OFFSET $3
  `;

  const result = await dbQuery(queryText, [guestFingerprint, limit, offset]);
  return result.rows;
}

/**
 * Get a specific guest session by ID with permission check
 */
export async function getGuestSession(sessionId: string, guestFingerprint: string): Promise<GuestChatSession | null> {
  const queryText = `
    SELECT id, guest_fingerprint as "guestFingerprint", title, created_at as "createdAt",
           updated_at as "updatedAt", last_message_at as "lastMessageAt",
           message_count as "messageCount", is_migrated as "isMigrated",
           migrated_to_user_id as "migratedToUserId", expires_at as "expiresAt"
    FROM guest_chat_sessions
    WHERE id = $1 AND guest_fingerprint = $2 AND expires_at > NOW()
  `;

  const result = await dbQuery(queryText, [sessionId, guestFingerprint]);
  return result.rows[0] || null;
}

/**
 * Update guest session title
 */
export async function updateGuestSession(
  sessionId: string,
  guestFingerprint: string,
  updates: { title?: string }
): Promise<GuestChatSession | null> {
  const setClauses: string[] = [];
  const values: any[] = [sessionId, guestFingerprint];
  let paramIndex = 3;

  if (updates.title !== undefined) {
    setClauses.push(`title = $${paramIndex++}`);
    values.push(updates.title);
  }

  if (setClauses.length === 0) {
    return getGuestSession(sessionId, guestFingerprint);
  }

  const queryText = `
    UPDATE guest_chat_sessions
    SET ${setClauses.join(', ')}
    WHERE id = $1 AND guest_fingerprint = $2 AND expires_at > NOW()
    RETURNING id, guest_fingerprint as "guestFingerprint", title, created_at as "createdAt",
               updated_at as "updatedAt", last_message_at as "lastMessageAt",
               message_count as "messageCount", is_migrated as "isMigrated",
               migrated_to_user_id as "migratedToUserId", expires_at as "expiresAt"
  `;

  const result = await dbQuery(queryText, values);
  return result.rows[0] || null;
}

/**
 * Delete a guest session and all its messages
 */
export async function deleteGuestSession(sessionId: string, guestFingerprint: string): Promise<boolean> {
  const queryText = `
    DELETE FROM guest_chat_sessions
    WHERE id = $1 AND guest_fingerprint = $2 AND expires_at > NOW()
  `;

  const result = await dbQuery(queryText, [sessionId, guestFingerprint]);
  return result.rowCount > 0;
}

/**
 * Add a message to a guest chat session
 */
export async function addGuestMessage(input: CreateGuestMessageInput): Promise<GuestChatMessage> {
  // Verify session exists and get guest permission
  const sessionCheck = await dbQuery(
    'SELECT guest_fingerprint FROM guest_chat_sessions WHERE id = $1 AND expires_at > NOW()',
    [input.sessionId]
  );

  if (sessionCheck.rows.length === 0) {
    throw new Error('Guest chat session not found or expired');
  }

  const queryText = `
    INSERT INTO guest_chat_messages (session_id, role, content, material_id, endpoint, tokens_used)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, session_id as "sessionId", role, content,
               material_id as "materialId", endpoint, created_at as "createdAt",
               tokens_used as "tokensUsed"
  `;

  const result = await dbQuery(queryText, [
    input.sessionId,
    input.role,
    input.content,
    input.materialId || null,
    input.endpoint || null,
    input.tokensUsed || 0
  ]);

  return result.rows[0];
}

/**
 * Get messages for a specific guest session with pagination
 */
export async function getGuestSessionMessages(
  sessionId: string,
  guestFingerprint: string,
  options: { limit?: number; offset?: number; beforeMessageId?: string } = {}
): Promise<GuestChatMessage[]> {
  const { limit = 50, offset = 0, beforeMessageId } = options;

  // Verify user has access to this session
  const sessionCheck = await dbQuery(
    'SELECT id FROM guest_chat_sessions WHERE id = $1 AND guest_fingerprint = $2 AND expires_at > NOW()',
    [sessionId, guestFingerprint]
  );

  if (sessionCheck.rows.length === 0) {
    throw new Error('Guest chat session not found, access denied, or expired');
  }

  let queryText = `
    SELECT id, session_id as "sessionId", role, content,
           material_id as "materialId", endpoint, created_at as "createdAt",
           tokens_used as "tokensUsed"
    FROM guest_chat_messages
    WHERE session_id = $1
  `;

  const values: any[] = [sessionId];
  let paramIndex = 2;

  if (beforeMessageId) {
    queryText += ` AND created_at < (SELECT created_at FROM guest_chat_messages WHERE id = $${paramIndex++})`;
    values.push(beforeMessageId);
  }

  queryText += ` ORDER BY created_at ASC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
  values.push(limit.toString(), offset.toString());

  const result = await dbQuery(queryText, values);
  return result.rows;
}

/**
 * Delete a specific guest message (with permission check)
 */
export async function deleteGuestMessage(messageId: string, guestFingerprint: string): Promise<boolean> {
  const queryText = `
    DELETE FROM guest_chat_messages
    WHERE id = $1 AND session_id IN (
      SELECT id FROM guest_chat_sessions WHERE guest_fingerprint = $2 AND expires_at > NOW()
    )
  `;

  const result = await dbQuery(queryText, [messageId, guestFingerprint]);
  return result.rowCount > 0;
}

/**
 * Get guest chat statistics for a fingerprint
 */
export async function getGuestChatStats(guestFingerprint: string): Promise<{
  totalSessions: number;
  totalMessages: number;
  messagesThisWeek: number;
  totalTokensUsed: number;
  favoriteEndpoints: Array<{ endpoint: string; count: number }>;
}> {
  const statsQuery = `
    SELECT
      COUNT(DISTINCT s.id) as total_sessions,
      COUNT(m.id) as total_messages,
      COUNT(CASE WHEN m.created_at > NOW() - INTERVAL '7 days' THEN 1 END) as messages_this_week,
      COALESCE(SUM(m.tokens_used), 0) as total_tokens_used
    FROM guest_chat_sessions s
    LEFT JOIN guest_chat_messages m ON s.id = m.session_id
    WHERE s.guest_fingerprint = $1 AND s.expires_at > NOW()
  `;

  const endpointsQuery = `
    SELECT
      m.endpoint,
      COUNT(*) as count
    FROM guest_chat_sessions s
    JOIN guest_chat_messages m ON s.id = m.session_id
    WHERE s.guest_fingerprint = $1 AND m.endpoint IS NOT NULL AND m.role = 'assistant' AND s.expires_at > NOW()
    GROUP BY m.endpoint
    ORDER BY count DESC
    LIMIT 5
  `;

  const [statsResult, endpointsResult] = await Promise.all([
    dbQuery(statsQuery, [guestFingerprint]),
    dbQuery(endpointsQuery, [guestFingerprint])
  ]);

  const stats = statsResult.rows[0];
  const endpoints = endpointsResult.rows.map((row: any) => ({
    endpoint: row.endpoint,
    count: parseInt(row.count)
  }));

  return {
    totalSessions: parseInt(stats.total_sessions) || 0,
    totalMessages: parseInt(stats.total_messages) || 0,
    messagesThisWeek: parseInt(stats.messages_this_week) || 0,
    totalTokensUsed: parseInt(stats.total_tokens_used) || 0,
    favoriteEndpoints: endpoints
  };
}

/**
 * Generate a smart title for a guest chat session based on first few messages
 */
export async function generateGuestSessionTitle(sessionId: string, guestFingerprint: string): Promise<string> {
  const messages = await getGuestSessionMessages(sessionId, guestFingerprint, { limit: 3 });

  if (messages.length === 0) {
    return 'New Chat';
  }

  // Get first user message
  const firstUserMessage = messages.find(m => m.role === 'user');
  if (!firstUserMessage) {
    return 'New Chat';
  }

  // Extract first 50 characters and clean up
  let title = firstUserMessage.content.substring(0, 50).trim();

  // Remove line breaks and extra spaces
  title = title.replace(/\s+/g, ' ');

  // Add ellipsis if truncated
  if (firstUserMessage.content.length > 50) {
    title += '...';
  }

  return title || 'New Chat';
}

/**
 * Create a guest session with auto-generated title from first message
 */
export async function createGuestSessionWithAutoTitle(
  guestFingerprint: string,
  firstMessage: string,
  endpoint?: string
): Promise<GuestChatSession> {
  // Generate title from first message
  let title = firstMessage.substring(0, 50).trim();
  title = title.replace(/\s+/g, ' ');

  if (firstMessage.length > 50) {
    title += '...';
  }

  // Add endpoint context if available
  if (endpoint && endpoint !== 'chat') {
    title = `[${endpoint}] ${title}`;
  }

  return createGuestSession({ guestFingerprint, title });
}

/**
 * Get pending migrations for a user (guest sessions that can be migrated)
 */
export async function getPendingMigrations(guestFingerprint: string): Promise<GuestChatSession[]> {
  const queryText = `
    SELECT id, guest_fingerprint as "guestFingerprint", title, created_at as "createdAt",
           updated_at as "updatedAt", last_message_at as "lastMessageAt",
           message_count as "messageCount", is_migrated as "isMigrated",
           migrated_to_user_id as "migratedToUserId", expires_at as "expiresAt"
    FROM guest_chat_sessions
    WHERE guest_fingerprint = $1
      AND is_migrated = FALSE
      AND expires_at > NOW()
    ORDER BY last_message_at DESC
  `;

  const result = await dbQuery(queryText, [guestFingerprint]);
  return result.rows;
}

/**
 * Migrate guest chat sessions to authenticated user
 */
export async function migrateGuestChatsToUser(
  guestFingerprint: string,
  userId: string,
  sessionIds?: string[]
): Promise<{ migrated: number; errors: string[] }> {
  const errors: string[] = [];
  let migrated = 0;

  // If specific session IDs provided, migrate only those
  if (sessionIds && sessionIds.length > 0) {
    for (const sessionId of sessionIds) {
      try {
        const success = await migrateSingleGuestSession(sessionId, guestFingerprint, userId);
        if (success) {
          migrated++;
        } else {
          errors.push(`Failed to migrate session ${sessionId}`);
        }
      } catch (error) {
        errors.push(`Error migrating session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    // Migrate all non-migrated sessions for this fingerprint
    const pendingSessions = await getPendingMigrations(guestFingerprint);

    for (const session of pendingSessions) {
      try {
        const success = await migrateSingleGuestSession(session.id, guestFingerprint, userId);
        if (success) {
          migrated++;
        } else {
          errors.push(`Failed to migrate session ${session.id}`);
        }
      } catch (error) {
        errors.push(`Error migrating session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { migrated, errors };
}

/**
 * Migrate a single guest session to authenticated user using database function
 */
async function migrateSingleGuestSession(
  sessionId: string,
  guestFingerprint: string,
  userId: string
): Promise<boolean> {
  const queryText = `
    SELECT migrate_guest_session_to_user($1, $2) as success
  `;

  const result = await dbQuery(queryText, [sessionId, userId]);

  if (result.rows.length === 0) {
    return false;
  }

  return result.rows[0].success === true;
}

/**
 * Clean up expired guest sessions
 */
export async function cleanupExpiredGuestSessions(): Promise<number> {
  const queryText = `
    SELECT cleanup_expired_guest_sessions() as cleaned_count
  `;

  const result = await dbQuery(queryText);
  return result.rows[0]?.cleaned_count || 0;
}

/**
 * Archive old guest sessions (older than 30 days with no recent activity)
 */
export async function archiveOldGuestSessions(guestFingerprint: string): Promise<number> {
  const queryText = `
    UPDATE guest_chat_sessions
    SET expires_at = NOW() - INTERVAL '1 second'
    WHERE guest_fingerprint = $1
      AND expires_at > NOW()
      AND last_message_at < NOW() - INTERVAL '30 days'
  `;

  const result = await dbQuery(queryText, [guestFingerprint]);
  return result.rowCount;
}