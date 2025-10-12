import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, testConnection } from './databaseService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Create migrations table if it doesn't exist
 */
async function createMigrationsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
}

/**
 * Get list of executed migrations
 */
async function getExecutedMigrations(): Promise<string[]> {
  const result = await query<{ filename: string }>('SELECT filename FROM migrations ORDER BY id');
  return result.rows.map(row => row.filename);
}

/**
 * Mark migration as executed
 */
async function markMigrationExecuted(filename: string): Promise<void> {
  await query('INSERT INTO migrations (filename) VALUES ($1)', [filename]);
}

/**
 * Get all migration files from migrations directory
 */
function getMigrationFiles(): string[] {
  const migrationsDir = path.join(__dirname, '../../migrations');
  
  if (!fs.existsSync(migrationsDir)) {
    console.log('No migrations directory found');
    return [];
  }
  
  return fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort();
}

/**
 * Execute a single migration file
 */
async function executeMigration(filename: string): Promise<void> {
  const migrationsDir = path.join(__dirname, '../../migrations');
  const filePath = path.join(migrationsDir, filename);
  
  console.log(`Executing migration: ${filename}`);
  
  const sql = fs.readFileSync(filePath, 'utf8');
  
  // Execute the entire SQL file as one statement to handle functions and triggers properly
  try {
    await query(sql);
  } catch (error) {
    console.error(`Error executing migration ${filename}:`);
    throw error;
  }
  
  await markMigrationExecuted(filename);
  console.log(`Migration completed: ${filename}`);
}

/**
 * Run all pending migrations
 */
export async function runMigrations(): Promise<void> {
  console.log('Starting database migrations...');
  
  // Test database connection first
  const connectionValid = await testConnection();
  if (!connectionValid) {
    throw new Error('Database connection test failed');
  }
  
  // Create migrations table
  await createMigrationsTable();
  
  // Get executed migrations and available migration files
  const executedMigrations = await getExecutedMigrations();
  const migrationFiles = getMigrationFiles();
  
  // Find pending migrations
  const pendingMigrations = migrationFiles.filter(
    file => !executedMigrations.includes(file)
  );
  
  if (pendingMigrations.length === 0) {
    console.log('No pending migrations');
    return;
  }
  
  console.log(`Found ${pendingMigrations.length} pending migrations`);
  
  // Execute pending migrations
  for (const migration of pendingMigrations) {
    await executeMigration(migration);
  }
  
  console.log('All migrations completed successfully');
}

/**
 * Check migration status
 */
export async function getMigrationStatus(): Promise<{
  executed: string[];
  pending: string[];
  total: number;
}> {
  await createMigrationsTable();
  
  const executedMigrations = await getExecutedMigrations();
  const migrationFiles = getMigrationFiles();
  const pendingMigrations = migrationFiles.filter(
    file => !executedMigrations.includes(file)
  );
  
  return {
    executed: executedMigrations,
    pending: pendingMigrations,
    total: migrationFiles.length
  };
}