import { config } from './env.js';

/**
 * SSL defaults to on in production. DATABASE_SSL=true|false overrides it:
 * npm runs every script with NODE_ENV=production because .npmrc sets
 * omit=dev, so a local Postgres without SSL is otherwise unreachable.
 */
function resolveSsl(): false | { rejectUnauthorized: boolean } {
  const override = process.env.DATABASE_SSL;
  const enabled = override ? /^(true|1|yes|on|require)$/i.test(override) : config.isProduction;
  return enabled ? { rejectUnauthorized: false } : false;
}

export const databaseConfig = {
  connectionString: config.databaseUrl || config.databasePublicUrl,
  
  // Fallback to individual components if needed
  host: config.pgHost,
  port: parseInt(config.pgPort || '5432'),
  database: config.pgDatabase,
  user: config.pgUser,
  password: config.pgPassword,
  
  // Connection pool settings
  ssl: resolveSsl(),
  max: 20, // max number of clients in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
}

// Validation helper
export function validateDatabaseConfig(): boolean {
  const hasConnectionString = !!(config.databaseUrl || config.databasePublicUrl);
  const hasIndividualComponents = !!(config.pgHost && config.pgUser && config.pgPassword);
  
  return hasConnectionString || hasIndividualComponents;
}

// Get connection string (Railway format)
export function getDatabaseConnectionString(): string | undefined {
  if (config.databaseUrl) {
    return config.databaseUrl;
  }
  
  if (config.databasePublicUrl) {
    return config.databasePublicUrl;
  }
  
  // Build from individual components if available
  if (config.pgHost && config.pgUser && config.pgPassword) {
    const port = config.pgPort || '5432';
    const database = config.pgDatabase || config.pgUser;
    return `postgresql://${config.pgUser}:${config.pgPassword}@${config.pgHost}:${port}/${database}`;
  }
  
  return undefined;
}