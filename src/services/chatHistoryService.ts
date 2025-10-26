import { query as dbQuery } from './databaseService.js';

export interface ChatSession {
  id: string;
  userId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  messageCount: number;
  isArchived: boolean;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  materialId?: string;
  endpoint?: string;
  createdAt: Date;
  tokensUsed: number;
}

export interface CreateSessionInput {
  userId: string;
  title: string;
}

export interface CreateMessageInput {
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  materialId?: string;
  endpoint?: string;
  tokensUsed?: number;
}

export interface SessionWithRecentMessage extends ChatSession {
  lastMessage?: string;
  lastMessageRole?: 'user' | 'assistant';
}

/**
 * Create a new chat session for a user
 */
export async function createSession(input: CreateSessionInput): Promise<ChatSession> {
  const queryText = `
    INSERT INTO chat_sessions (user_id, title)
    VALUES ($1, $2)
    RETURNING id, user_id as "userId", title, created_at as "createdAt", 
              updated_at as "updatedAt", last_message_at as "lastMessageAt",
              message_count as "messageCount", is_archived as "isArchived"
  `;
  
  const result = await dbQuery(queryText, [input.userId, input.title]);
  return result.rows[0];
}

/**
 * Get all chat sessions for a user with pagination
 */
export async function getUserSessions(
  userId: string, 
  options: { limit?: number; offset?: number; includeArchived?: boolean } = {}
): Promise<SessionWithRecentMessage[]> {
  const { limit = 20, offset = 0, includeArchived = false } = options;
  
  const queryText = `
    SELECT 
      s.id, s.user_id as "userId", s.title, s.created_at as "createdAt",
      s.updated_at as "updatedAt", s.last_message_at as "lastMessageAt",
      s.message_count as "messageCount", s.is_archived as "isArchived",
      m.content as "lastMessage", m.role as "lastMessageRole"
    FROM chat_sessions s
    LEFT JOIN LATERAL (
      SELECT content, role FROM chat_messages 
      WHERE session_id = s.id 
      ORDER BY created_at DESC 
      LIMIT 1
    ) m ON true
    WHERE s.user_id = $1 
      ${includeArchived ? '' : 'AND s.is_archived = FALSE'}
    ORDER BY s.last_message_at DESC
    LIMIT $2 OFFSET $3
  `;
  
  const result = await dbQuery(queryText, [userId, limit, offset]);
  return result.rows;
}

/**
 * Get a specific session by ID with permission check
 */
export async function getSession(sessionId: string, userId: string): Promise<ChatSession | null> {
  const queryText = `
    SELECT id, user_id as "userId", title, created_at as "createdAt",
           updated_at as "updatedAt", last_message_at as "lastMessageAt",
           message_count as "messageCount", is_archived as "isArchived"
    FROM chat_sessions
    WHERE id = $1 AND user_id = $2
  `;
  
  const result = await dbQuery(queryText, [sessionId, userId]);
  return result.rows[0] || null;
}

/**
 * Update session title or archive status
 */
export async function updateSession(
  sessionId: string, 
  userId: string, 
  updates: { title?: string; isArchived?: boolean }
): Promise<ChatSession | null> {
  const setClauses: string[] = [];
  const values: any[] = [sessionId, userId];
  let paramIndex = 3;

  if (updates.title !== undefined) {
    setClauses.push(`title = $${paramIndex++}`);
    values.push(updates.title);
  }

  if (updates.isArchived !== undefined) {
    setClauses.push(`is_archived = $${paramIndex++}`);
    values.push(updates.isArchived);
  }

  if (setClauses.length === 0) {
    return getSession(sessionId, userId);
  }

  const queryText = `
    UPDATE chat_sessions 
    SET ${setClauses.join(', ')}
    WHERE id = $1 AND user_id = $2
    RETURNING id, user_id as "userId", title, created_at as "createdAt",
              updated_at as "updatedAt", last_message_at as "lastMessageAt",
              message_count as "messageCount", is_archived as "isArchived"
  `;

  const result = await dbQuery(queryText, values);
  return result.rows[0] || null;
}

/**
 * Delete a session and all its messages
 */
export async function deleteSession(sessionId: string, userId: string): Promise<boolean> {
  const queryText = `
    DELETE FROM chat_sessions 
    WHERE id = $1 AND user_id = $2
  `;
  
  const result = await dbQuery(queryText, [sessionId, userId]);
  return result.rowCount > 0;
}

/**
 * Add a message to a chat session
 */
export async function addMessage(input: CreateMessageInput): Promise<ChatMessage> {
  // Verify session exists and get user permission
  const sessionCheck = await dbQuery(
    'SELECT user_id FROM chat_sessions WHERE id = $1',
    [input.sessionId]
  );

  if (sessionCheck.rows.length === 0) {
    throw new Error('Chat session not found');
  }

  const queryText = `
    INSERT INTO chat_messages (session_id, role, content, material_id, endpoint, tokens_used)
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
 * Get messages for a specific session with pagination
 */
export async function getSessionMessages(
  sessionId: string, 
  userId: string,
  options: { limit?: number; offset?: number; beforeMessageId?: string } = {}
): Promise<ChatMessage[]> {
  const { limit = 50, offset = 0, beforeMessageId } = options;

  // Verify user has access to this session
  const sessionCheck = await dbQuery(
    'SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2',
    [sessionId, userId]
  );

  if (sessionCheck.rows.length === 0) {
    throw new Error('Chat session not found or access denied');
  }

  let queryText = `
    SELECT id, session_id as "sessionId", role, content,
           material_id as "materialId", endpoint, created_at as "createdAt",
           tokens_used as "tokensUsed"
    FROM chat_messages
    WHERE session_id = $1
  `;

  const values: any[] = [sessionId];
  let paramIndex = 2;

  if (beforeMessageId) {
    queryText += ` AND created_at < (SELECT created_at FROM chat_messages WHERE id = $${paramIndex++})`;
    values.push(beforeMessageId);
  }

  queryText += ` ORDER BY created_at ASC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
  values.push(limit.toString(), offset.toString());

  const result = await dbQuery(queryText, values);
  return result.rows;
}

/**
 * Delete a specific message (with permission check)
 */
export async function deleteMessage(messageId: string, userId: string): Promise<boolean> {
  const queryText = `
    DELETE FROM chat_messages
    WHERE id = $1 AND session_id IN (
      SELECT id FROM chat_sessions WHERE user_id = $2
    )
  `;

  const result = await dbQuery(queryText, [messageId, userId]);
  return result.rowCount > 0;
}

/**
 * Get chat statistics for a user
 */
export async function getUserChatStats(userId: string): Promise<{
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
    FROM chat_sessions s
    LEFT JOIN chat_messages m ON s.id = m.session_id
    WHERE s.user_id = $1
  `;

  const endpointsQuery = `
    SELECT 
      m.endpoint,
      COUNT(*) as count
    FROM chat_sessions s
    JOIN chat_messages m ON s.id = m.session_id
    WHERE s.user_id = $1 AND m.endpoint IS NOT NULL AND m.role = 'assistant'
    GROUP BY m.endpoint
    ORDER BY count DESC
    LIMIT 5
  `;

  const [statsResult, endpointsResult] = await Promise.all([
    dbQuery(statsQuery, [userId]),
    dbQuery(endpointsQuery, [userId])
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
 * Generate a smart title for a chat session based on first few messages
 */
export async function generateSessionTitle(sessionId: string, userId: string): Promise<string> {
  const messages = await getSessionMessages(sessionId, userId, { limit: 3 });
  
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
 * Archive old sessions (older than 30 days with no recent activity)
 */
export async function archiveOldSessions(userId: string): Promise<number> {
  const queryText = `
    UPDATE chat_sessions
    SET is_archived = true
    WHERE user_id = $1
      AND is_archived = false
      AND last_message_at < NOW() - INTERVAL '30 days'
  `;

  const result = await dbQuery(queryText, [userId]);
  return result.rowCount;
}

/**
 * Get all chat sessions for a user including migrated guest sessions
 */
export async function getAllUserSessions(
  userId: string,
  options: { limit?: number; offset?: number; includeArchived?: boolean } = {}
): Promise<SessionWithRecentMessage[]> {
  const { limit = 20, offset = 0, includeArchived = false } = options;

  const queryText = `
    SELECT
      s.id, s.user_id as "userId", s.title, s.created_at as "createdAt",
      s.updated_at as "updatedAt", s.last_message_at as "lastMessageAt",
      s.message_count as "messageCount", s.is_archived as "isArchived",
      m.content as "lastMessage", m.role as "lastMessageRole",
      'authenticated' as "sessionType"
    FROM chat_sessions s
    LEFT JOIN LATERAL (
      SELECT content, role FROM chat_messages
      WHERE session_id = s.id
      ORDER BY created_at DESC
      LIMIT 1
    ) m ON true
    WHERE s.user_id = $1
      ${includeArchived ? '' : 'AND s.is_archived = FALSE'}
    ORDER BY s.last_message_at DESC
    LIMIT $2 OFFSET $3
  `;

  const result = await dbQuery(queryText, [userId, limit, offset]);
  return result.rows;
}

/**
 * Check if a user has any guest sessions that can be migrated
 */
export async function hasPendingGuestMigrations(guestFingerprint: string): Promise<boolean> {
  const queryText = `
    SELECT COUNT(*) as count
    FROM guest_chat_sessions
    WHERE guest_fingerprint = $1
      AND is_migrated = FALSE
      AND expires_at > NOW()
  `;

  const result = await dbQuery(queryText, [guestFingerprint]);
  return parseInt(result.rows[0].count) > 0;
}

/**
 * Get guest sessions that were migrated to a specific user
 */
export async function getMigratedGuestSessions(userId: string): Promise<SessionWithRecentMessage[]> {
  const queryText = `
    SELECT
      s.id, s.user_id as "userId", s.title, s.created_at as "createdAt",
      s.updated_at as "updatedAt", s.last_message_at as "lastMessageAt",
      s.message_count as "messageCount", s.is_archived as "isArchived",
      m.content as "lastMessage", m.role as "lastMessageRole",
      'migrated' as "sessionType"
    FROM chat_sessions s
    LEFT JOIN LATERAL (
      SELECT content, role FROM chat_messages
      WHERE session_id = s.id
      ORDER BY created_at DESC
      LIMIT 1
    ) m ON true
    WHERE s.user_id = $1
      AND s.title LIKE '%[migrated]%'
    ORDER BY s.created_at DESC
  `;

  const result = await dbQuery(queryText, [userId]);
  return result.rows;
}

/**
 * Search chat sessions by title or content
 */
export async function searchChatSessions(
  userId: string,
  searchQuery: string,
  options: { limit?: number; offset?: number; includeArchived?: boolean } = {}
): Promise<SessionWithRecentMessage[]> {
  const { limit = 20, offset = 0, includeArchived = false } = options;

  const queryText = `
    SELECT
      s.id, s.user_id as "userId", s.title, s.created_at as "createdAt",
      s.updated_at as "updatedAt", s.last_message_at as "lastMessageAt",
      s.message_count as "messageCount", s.is_archived as "isArchived",
      m.content as "lastMessage", m.role as "lastMessageRole"
    FROM chat_sessions s
    LEFT JOIN LATERAL (
      SELECT content, role FROM chat_messages
      WHERE session_id = s.id
      ORDER BY created_at DESC
      LIMIT 1
    ) m ON true
    WHERE s.user_id = $1
      ${includeArchived ? '' : 'AND s.is_archived = FALSE'}
      AND (s.title ILIKE $2 OR m.content ILIKE $3)
    ORDER BY s.last_message_at DESC
    LIMIT $4 OFFSET $5
  `;

  const searchPattern = `%${searchQuery}%`;
  const result = await dbQuery(queryText, [userId, searchPattern, searchPattern, limit, offset]);
  return result.rows;
}