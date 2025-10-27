#!/usr/bin/env node
/**
 * Set Admin Script
 * Sets a user as admin by email
 *
 * Usage:
 *   npm run set-admin your-email@example.com
 *   npx tsx scripts/set-admin.ts your-email@example.com
 */

import { query, closeDatabase } from '../src/services/databaseService.js';

async function setAdmin(email: string) {
  console.log('🔧 Setting admin privileges...\n');

  try {
    // Check if user exists
    const userResult = await query(
      'SELECT id, email, name, is_admin FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      console.log('❌ User not found with email:', email);
      console.log('\nAvailable users:');
      const allUsers = await query('SELECT email, name FROM users ORDER BY created_at DESC LIMIT 10');
      allUsers.rows.forEach((user: any) => {
        console.log(`   - ${user.email} (${user.name})`);
      });
      process.exit(1);
    }

    const user = userResult.rows[0];

    if (user.is_admin) {
      console.log(`ℹ️  User ${email} is already an admin!`);
      console.log(`   Name: ${user.name}`);
      console.log(`   ID: ${user.id}`);
      process.exit(0);
    }

    // Set user as admin
    await query(
      'UPDATE users SET is_admin = TRUE, updated_at = NOW() WHERE id = $1',
      [user.id]
    );

    console.log('✅ Admin privileges granted successfully!');
    console.log(`\n📧 Email: ${user.email}`);
    console.log(`👤 Name: ${user.name}`);
    console.log(`🆔 User ID: ${user.id}`);
    console.log(`\n🎉 ${user.name} is now an admin with unlimited token access!`);
    console.log(`\nThey can now access:`);
    console.log(`   - Admin Dashboard: http://localhost:8787/admin-usage.html`);
    console.log(`   - Unlimited AI token usage`);
    console.log(`   - User management features`);

  } catch (error) {
    console.error('❌ Error setting admin:', error);
    process.exit(1);
  } finally {
    await closeDatabase();
  }
}

// Parse command line arguments
const email = process.argv[2];

if (!email) {
  console.log('Usage: npm run set-admin <email>');
  console.log('Example: npm run set-admin user@example.com');
  process.exit(1);
}

setAdmin(email);
