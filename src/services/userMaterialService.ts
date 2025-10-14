import { query as dbQuery } from './databaseService.js';
import { materialService } from './materialService.js';

export interface UserMaterial {
  id: string;
  userId: string;
  materialId: string;
  title: string;
  description?: string;
  fileNames: string[];
  fileTypes: string[];
  contentPreview: string;
  wordCount: number;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date;
  accessCount: number;
  isFavorite: boolean;
  tags: string[];
}

export interface CreateUserMaterialInput {
  userId: string;
  materialId: string;
  title: string;
  description?: string;
  fileNames: string[];
  fileTypes: string[];
  tags?: string[];
}

export interface UpdateUserMaterialInput {
  title?: string;
  description?: string;
  isFavorite?: boolean;
  tags?: string[];
}

export interface MaterialSearchOptions {
  limit?: number;
  offset?: number;
  sortBy?: 'created_at' | 'title' | 'last_accessed_at' | 'access_count';
  sortOrder?: 'asc' | 'desc';
  tags?: string[];
  searchQuery?: string;
  favoritesOnly?: boolean;
}

/**
 * Save a material to user's collection with metadata
 */
export async function saveUserMaterial(input: CreateUserMaterialInput): Promise<UserMaterial> {
  // Get material content to generate preview and word count
  const content = await materialService.readMaterial(input.materialId);
  const contentPreview = content.substring(0, 500).trim();
  const wordCount = content.split(/\s+/).filter((word: string) => word.length > 0).length;

  const queryText = `
    INSERT INTO user_materials (
      user_id, material_id, title, description, file_names, file_types, 
      content_preview, word_count, tags
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id, user_id as "userId", material_id as "materialId", title, description,
              file_names as "fileNames", file_types as "fileTypes", content_preview as "contentPreview",
              word_count as "wordCount", created_at as "createdAt", updated_at as "updatedAt",
              last_accessed_at as "lastAccessedAt", access_count as "accessCount",
              is_favorite as "isFavorite", tags
  `;

  const result = await dbQuery(queryText, [
    input.userId,
    input.materialId,
    input.title,
    input.description || null,
    input.fileNames,
    input.fileTypes,
    contentPreview,
    wordCount,
    input.tags || []
  ]);

  return result.rows[0];
}

/**
 * Get all saved materials for a user with filtering and pagination
 */
export async function getUserMaterials(
  userId: string,
  options: MaterialSearchOptions = {}
): Promise<UserMaterial[]> {
  const {
    limit = 20,
    offset = 0,
    sortBy = 'created_at',
    sortOrder = 'desc',
    tags,
    searchQuery,
    favoritesOnly = false
  } = options;

  let queryText = `
    SELECT id, user_id as "userId", material_id as "materialId", title, description,
           file_names as "fileNames", file_types as "fileTypes", content_preview as "contentPreview",
           word_count as "wordCount", created_at as "createdAt", updated_at as "updatedAt",
           last_accessed_at as "lastAccessedAt", access_count as "accessCount",
           is_favorite as "isFavorite", tags
    FROM user_materials
    WHERE user_id = $1
  `;

  const values: any[] = [userId];
  let paramIndex = 2;

  // Add filters
  if (favoritesOnly) {
    queryText += ` AND is_favorite = true`;
  }

  if (tags && tags.length > 0) {
    queryText += ` AND tags && $${paramIndex++}`;
    values.push(tags);
  }

  if (searchQuery) {
    queryText += ` AND (
      title ILIKE $${paramIndex++} OR 
      description ILIKE $${paramIndex} OR 
      content_preview ILIKE $${paramIndex}
    )`;
    const searchPattern = `%${searchQuery}%`;
    values.push(searchPattern, searchPattern);
    paramIndex += 2;
  }

  // Add sorting
  const validSortColumns = ['created_at', 'title', 'last_accessed_at', 'access_count'];
  const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
  const order = sortOrder === 'asc' ? 'ASC' : 'DESC';
  
  queryText += ` ORDER BY ${sortColumn} ${order}`;
  queryText += ` LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
  values.push(limit, offset);

  const result = await dbQuery(queryText, values);
  return result.rows;
}

/**
 * Get a specific saved material by ID with permission check
 */
export async function getUserMaterial(materialId: string, userId: string): Promise<UserMaterial | null> {
  const queryText = `
    SELECT id, user_id as "userId", material_id as "materialId", title, description,
           file_names as "fileNames", file_types as "fileTypes", content_preview as "contentPreview",
           word_count as "wordCount", created_at as "createdAt", updated_at as "updatedAt",
           last_accessed_at as "lastAccessedAt", access_count as "accessCount",
           is_favorite as "isFavorite", tags
    FROM user_materials
    WHERE material_id = $1 AND user_id = $2
  `;

  const result = await dbQuery(queryText, [materialId, userId]);
  return result.rows[0] || null;
}

/**
 * Update a saved material's metadata
 */
export async function updateUserMaterial(
  materialId: string,
  userId: string,
  updates: UpdateUserMaterialInput
): Promise<UserMaterial | null> {
  const setClauses: string[] = [];
  const values: any[] = [materialId, userId];
  let paramIndex = 3;

  if (updates.title !== undefined) {
    setClauses.push(`title = $${paramIndex++}`);
    values.push(updates.title);
  }

  if (updates.description !== undefined) {
    setClauses.push(`description = $${paramIndex++}`);
    values.push(updates.description);
  }

  if (updates.isFavorite !== undefined) {
    setClauses.push(`is_favorite = $${paramIndex++}`);
    values.push(updates.isFavorite);
  }

  if (updates.tags !== undefined) {
    setClauses.push(`tags = $${paramIndex++}`);
    values.push(updates.tags);
  }

  if (setClauses.length === 0) {
    return getUserMaterial(materialId, userId);
  }

  const queryText = `
    UPDATE user_materials 
    SET ${setClauses.join(', ')}
    WHERE material_id = $1 AND user_id = $2
    RETURNING id, user_id as "userId", material_id as "materialId", title, description,
              file_names as "fileNames", file_types as "fileTypes", content_preview as "contentPreview",
              word_count as "wordCount", created_at as "createdAt", updated_at as "updatedAt",
              last_accessed_at as "lastAccessedAt", access_count as "accessCount",
              is_favorite as "isFavorite", tags
  `;

  const result = await dbQuery(queryText, values);
  return result.rows[0] || null;
}

/**
 * Record access to a material (increment access count and update timestamp)
 */
export async function recordMaterialAccess(materialId: string, userId: string): Promise<void> {
  const queryText = `
    UPDATE user_materials 
    SET access_count = access_count + 1,
        last_accessed_at = NOW()
    WHERE material_id = $1 AND user_id = $2
  `;

  await dbQuery(queryText, [materialId, userId]);
}

/**
 * Delete a saved material from user's collection
 */
export async function deleteUserMaterial(materialId: string, userId: string): Promise<boolean> {
  const queryText = `
    DELETE FROM user_materials
    WHERE material_id = $1 AND user_id = $2
  `;

  const result = await dbQuery(queryText, [materialId, userId]);
  return result.rowCount > 0;
}

/**
 * Get all unique tags used by a user
 */
export async function getUserTags(userId: string): Promise<string[]> {
  const queryText = `
    SELECT DISTINCT unnest(tags) as tag
    FROM user_materials
    WHERE user_id = $1 AND array_length(tags, 1) > 0
    ORDER BY tag
  `;

  const result = await dbQuery(queryText, [userId]);
  return result.rows.map((row: any) => row.tag);
}

/**
 * Get material statistics for a user
 */
export async function getUserMaterialStats(userId: string): Promise<{
  totalMaterials: number;
  favoriteMaterials: number;
  totalWordCount: number;
  materialsThisWeek: number;
  mostUsedTags: Array<{ tag: string; count: number }>;
  topFileTypes: Array<{ type: string; count: number }>;
}> {
  const statsQuery = `
    SELECT 
      COUNT(*) as total_materials,
      COUNT(CASE WHEN is_favorite = true THEN 1 END) as favorite_materials,
      COALESCE(SUM(word_count), 0) as total_word_count,
      COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as materials_this_week
    FROM user_materials
    WHERE user_id = $1
  `;

  const tagsQuery = `
    SELECT unnest(tags) as tag, COUNT(*) as count
    FROM user_materials
    WHERE user_id = $1 AND array_length(tags, 1) > 0
    GROUP BY tag
    ORDER BY count DESC
    LIMIT 10
  `;

  const fileTypesQuery = `
    SELECT unnest(file_types) as type, COUNT(*) as count
    FROM user_materials
    WHERE user_id = $1
    GROUP BY type
    ORDER BY count DESC
    LIMIT 5
  `;

  const [statsResult, tagsResult, fileTypesResult] = await Promise.all([
    dbQuery(statsQuery, [userId]),
    dbQuery(tagsQuery, [userId]),
    dbQuery(fileTypesQuery, [userId])
  ]);

  const stats = statsResult.rows[0];
  const mostUsedTags = tagsResult.rows.map((row: any) => ({
    tag: row.tag,
    count: parseInt(row.count)
  }));
  const topFileTypes = fileTypesResult.rows.map((row: any) => ({
    type: row.type,
    count: parseInt(row.count)
  }));

  return {
    totalMaterials: parseInt(stats.total_materials) || 0,
    favoriteMaterials: parseInt(stats.favorite_materials) || 0,
    totalWordCount: parseInt(stats.total_word_count) || 0,
    materialsThisWeek: parseInt(stats.materials_this_week) || 0,
    mostUsedTags,
    topFileTypes
  };
}

/**
 * Check if a material is already saved by user
 */
export async function isMaterialSaved(materialId: string, userId: string): Promise<boolean> {
  const queryText = `
    SELECT EXISTS(
      SELECT 1 FROM user_materials 
      WHERE material_id = $1 AND user_id = $2
    ) as exists
  `;

  const result = await dbQuery(queryText, [materialId, userId]);
  return result.rows[0].exists;
}

/**
 * Get recently accessed materials for quick access
 */
export async function getRecentlyAccessedMaterials(userId: string, limit: number = 5): Promise<UserMaterial[]> {
  const queryText = `
    SELECT id, user_id as "userId", material_id as "materialId", title, description,
           file_names as "fileNames", file_types as "fileTypes", content_preview as "contentPreview",
           word_count as "wordCount", created_at as "createdAt", updated_at as "updatedAt",
           last_accessed_at as "lastAccessedAt", access_count as "accessCount",
           is_favorite as "isFavorite", tags
    FROM user_materials
    WHERE user_id = $1 AND access_count > 0
    ORDER BY last_accessed_at DESC
    LIMIT $2
  `;

  const result = await dbQuery(queryText, [userId, limit]);
  return result.rows;
}

/**
 * Get materials by tag for tag-based browsing
 */
export async function getMaterialsByTag(userId: string, tag: string): Promise<UserMaterial[]> {
  const queryText = `
    SELECT id, user_id as "userId", material_id as "materialId", title, description,
           file_names as "fileNames", file_types as "fileTypes", content_preview as "contentPreview",
           word_count as "wordCount", created_at as "createdAt", updated_at as "updatedAt",
           last_accessed_at as "lastAccessedAt", access_count as "accessCount",
           is_favorite as "isFavorite", tags
    FROM user_materials
    WHERE user_id = $1 AND $2 = ANY(tags)
    ORDER BY created_at DESC
  `;

  const result = await dbQuery(queryText, [userId, tag]);
  return result.rows;
}