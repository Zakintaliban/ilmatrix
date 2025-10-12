import { Pool, PoolClient } from 'pg';
import { databaseConfig, validateDatabaseConfig, getDatabaseConnectionString } from '../config/database.js';

let pool: Pool | null = null;

/**
 * Initialize database connection pool
 */
export function initializeDatabase(): Pool {
  if (pool) {
    return pool;
  }

  if (!validateDatabaseConfig()) {
    throw new Error('Database configuration is incomplete. Missing DATABASE_URL or individual PG components.');
  }

  const connectionString = getDatabaseConnectionString();
  if (!connectionString) {
    throw new Error('Unable to construct database connection string');
  }

  pool = new Pool({
    connectionString,
    ssl: databaseConfig.ssl,
    max: databaseConfig.max,
    idleTimeoutMillis: databaseConfig.idleTimeoutMillis,
    connectionTimeoutMillis: databaseConfig.connectionTimeoutMillis,
  });

  // Handle pool errors
  pool.on('error', (err: Error) => {
    console.error('Unexpected error on idle client', err);
  });

  console.log('Database connection pool initialized');
  return pool;
}

/**
 * Get database connection pool
 */
export function getDatabase(): Pool {
  if (!pool) {
    return initializeDatabase();
  }
  return pool;
}

/**
 * Execute a query with automatic connection handling
 */
export async function query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }> {
  const db = getDatabase();
  const result = await db.query(text, params);
  return {
    rows: result.rows,
    rowCount: result.rowCount || 0,
  };
}

/**
 * Execute a transaction
 */
export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const db = getDatabase();
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Close database connection pool
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('Database connection pool closed');
  }
}

/**
 * Test database connection
 */
export async function testConnection(): Promise<boolean> {
  try {
    const result = await query('SELECT NOW() as current_time');
    console.log('Database connection test successful:', result.rows[0]);
    return true;
  } catch (error) {
    console.error('Database connection test failed:', error);
    return false;
  }
}

// Export types for convenience
export type { Pool, PoolClient } from 'pg';