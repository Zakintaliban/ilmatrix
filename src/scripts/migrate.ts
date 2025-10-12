#!/usr/bin/env node
import { runMigrations, getMigrationStatus } from '../services/migrationService.js';
import { closeDatabase } from '../services/databaseService.js';

async function main() {
  const command = process.argv[2];
  
  try {
    switch (command) {
      case 'run':
        await runMigrations();
        break;
        
      case 'status':
        const status = await getMigrationStatus();
        console.log('\n=== Migration Status ===');
        console.log(`Total migrations: ${status.total}`);
        console.log(`Executed: ${status.executed.length}`);
        console.log(`Pending: ${status.pending.length}`);
        
        if (status.executed.length > 0) {
          console.log('\nExecuted migrations:');
          status.executed.forEach(m => console.log(`  ✓ ${m}`));
        }
        
        if (status.pending.length > 0) {
          console.log('\nPending migrations:');
          status.pending.forEach(m => console.log(`  ○ ${m}`));
        }
        break;
        
      default:
        console.log('Usage:');
        console.log('  npm run migrate run     - Run all pending migrations');
        console.log('  npm run migrate status  - Show migration status');
        process.exit(1);
    }
    
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await closeDatabase();
  }
}

main();