import crypto from 'crypto';
import { Context } from 'hono';
import * as guestChatService from './guestChatService.js';

interface GuestSession {
  fingerprint: string;
  usageCount: number;
  firstAccess: Date;
  lastAccess: Date;
  ipAddress: string;
  userAgent: string;
  chatSessionCount: number;
  lastChatActivity: Date;
}

class GuestSessionManager {
  private sessions = new Map<string, GuestSession>();
  private readonly MAX_USAGE = 5;
  private readonly SESSION_EXPIRY_HOURS = 24;

  /**
   * Get or create device ID from HTTP-only cookie
   * This provides persistent tracking even if IP changes
   */
  private getOrCreateDeviceId(c: Context): string {
    // Try to get existing device ID from cookie
    const cookieHeader = c.req.header('cookie');
    if (cookieHeader) {
      const match = cookieHeader.match(/device_id=([^;]+)/);
      if (match) {
        return match[1];
      }
    }

    // Generate new device ID if not found
    const newDeviceId = crypto.randomUUID();

    // Set HTTP-only cookie (expires in 1 year)
    // HttpOnly: prevents JavaScript access (XSS protection)
    // Secure: only sent over HTTPS
    // SameSite=Lax: CSRF protection while allowing normal navigation
    const maxAge = 365 * 24 * 60 * 60; // 1 year in seconds
    c.header('Set-Cookie',
      `device_id=${newDeviceId}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}; Path=/`
    );

    return newDeviceId;
  }

  /**
   * Get browser fingerprint for monitoring/logging purposes
   * This includes IP and headers for anomaly detection
   */
  private getBrowserFingerprint(c: Context): string {
    const ipAddress = this.getClientIP(c);
    const userAgent = c.req.header('user-agent') || 'unknown';
    const acceptLanguage = c.req.header('accept-language') || 'unknown';
    const acceptEncoding = c.req.header('accept-encoding') || 'unknown';
    const accept = c.req.header('accept') || 'unknown';

    const data = `${ipAddress}:${userAgent}:${acceptLanguage}:${acceptEncoding}:${accept}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 12);
  }

  /**
   * Generate unique fingerprint for guest identification
   * PRIMARY KEY: device_id (persists across IP/browser changes)
   * SECONDARY: browser fingerprint (for monitoring)
   *
   * This approach blocks VPN/Warp bypass because device_id is the session key
   */
  generateFingerprint(c: Context): string {
    // Device ID is the primary identifier (persists in HTTP-only cookie)
    const deviceId = this.getOrCreateDeviceId(c);

    // Browser fingerprint is for monitoring only (detect suspicious changes)
    const browserFingerprint = this.getBrowserFingerprint(c);

    // Store browser fingerprint for anomaly detection (optional future use)
    const session = this.sessions.get(deviceId);
    if (session) {
      session.ipAddress = this.getClientIP(c);
      session.userAgent = c.req.header('user-agent') || 'unknown';
    }

    // Return device_id as the fingerprint (session key)
    // This ensures VPN/Warp bypass doesn't work
    return deviceId;
  }

  /**
   * Get client IP address with proxy support
   */
  private getClientIP(c: Context): string {
    // Check for forwarded headers (Railway, Cloudflare, etc.)
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }
    
    const realIP = c.req.header('x-real-ip');
    if (realIP) {
      return realIP;
    }
    
    // Fallback to connection remote address
    return c.req.header('x-forwarded-for') || 'unknown';
  }

  /**
   * Get current usage count for a guest
   */
  getUsageCount(fingerprint: string): number {
    const session = this.sessions.get(fingerprint);
    
    if (!session) {
      return 0;
    }
    
    // Check if session is expired
    if (this.isSessionExpired(session)) {
      this.sessions.delete(fingerprint);
      return 0;
    }
    
    return session.usageCount;
  }

  /**
   * Increment usage count for a guest
   */
  incrementUsage(c: Context): { fingerprint: string; newCount: number; remaining: number } {
    const fingerprint = this.generateFingerprint(c);
    const ipAddress = this.getClientIP(c);
    const userAgent = c.req.header('user-agent') || 'unknown';
    
    let session = this.sessions.get(fingerprint);

    if (!session || this.isSessionExpired(session)) {
      // Create new session
      session = {
        fingerprint,
        usageCount: 0,
        firstAccess: new Date(),
        lastAccess: new Date(),
        ipAddress,
        userAgent,
        chatSessionCount: 0,
        lastChatActivity: new Date()
      };
    }

    // Increment usage
    session.usageCount++;
    session.lastAccess = new Date();

    // Update session
    this.sessions.set(fingerprint, session);
    
    return {
      fingerprint,
      newCount: session.usageCount,
      remaining: Math.max(0, this.MAX_USAGE - session.usageCount)
    };
  }

  /**
   * Check if guest has reached usage limit
   */
  isLimitReached(fingerprint: string): boolean {
    const usageCount = this.getUsageCount(fingerprint);
    return usageCount >= this.MAX_USAGE;
  }

  /**
   * Get usage stats for a guest
   */
  getUsageStats(c: Context): { current: number; max: number; remaining: number; fingerprint: string } {
    const fingerprint = this.generateFingerprint(c);
    const current = this.getUsageCount(fingerprint);
    
    return {
      current,
      max: this.MAX_USAGE,
      remaining: Math.max(0, this.MAX_USAGE - current),
      fingerprint
    };
  }

  /**
   * Reset usage for a guest (called after successful login)
   */
  resetUsage(fingerprint: string): void {
    this.sessions.delete(fingerprint);
  }

  /**
   * Check if session is expired
   */
  private isSessionExpired(session: GuestSession): boolean {
    const now = new Date();
    const expiryTime = new Date(session.lastAccess);
    expiryTime.setHours(expiryTime.getHours() + this.SESSION_EXPIRY_HOURS);
    
    return now > expiryTime;
  }

  /**
   * Cleanup expired sessions
   */
  cleanupExpiredSessions(): { cleaned: number; total: number } {
    const beforeCount = this.sessions.size;
    let cleanedCount = 0;
    
    for (const [fingerprint, session] of this.sessions.entries()) {
      if (this.isSessionExpired(session)) {
        this.sessions.delete(fingerprint);
        cleanedCount++;
      }
    }
    
    console.log(`Guest sessions cleanup: removed ${cleanedCount} expired sessions, ${this.sessions.size} remaining`);
    
    return {
      cleaned: cleanedCount,
      total: this.sessions.size
    };
  }

  /**
   * Get all session statistics (for monitoring)
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    expiredSessions: number;
    usageDistribution: Record<number, number>;
  } {
    let activeSessions = 0;
    let expiredSessions = 0;
    const usageDistribution: Record<number, number> = {};

    for (const session of this.sessions.values()) {
      if (this.isSessionExpired(session)) {
        expiredSessions++;
      } else {
        activeSessions++;
        const usage = session.usageCount;
        usageDistribution[usage] = (usageDistribution[usage] || 0) + 1;
      }
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      expiredSessions,
      usageDistribution
    };
  }

  /**
   * Update chat activity for a guest session
   */
  updateChatActivity(fingerprint: string): void {
    const session = this.sessions.get(fingerprint);

    if (session && !this.isSessionExpired(session)) {
      session.lastChatActivity = new Date();
      this.sessions.set(fingerprint, session);
    }
  }

  /**
   * Increment chat session count for a guest
   */
  incrementChatSessionCount(fingerprint: string): void {
    let session = this.sessions.get(fingerprint);

    if (!session || this.isSessionExpired(session)) {
      // This shouldn't happen in normal flow, but handle gracefully
      return;
    }

    session.chatSessionCount++;
    session.lastChatActivity = new Date();
    this.sessions.set(fingerprint, session);
  }

  /**
   * Get chat statistics for a guest
   */
  getChatStats(fingerprint: string): {
    sessionCount: number;
    lastActivity: Date | null;
    hasActiveChats: boolean;
  } {
    const session = this.sessions.get(fingerprint);

    if (!session || this.isSessionExpired(session)) {
      return {
        sessionCount: 0,
        lastActivity: null,
        hasActiveChats: false
      };
    }

    return {
      sessionCount: session.chatSessionCount,
      lastActivity: session.lastChatActivity,
      hasActiveChats: session.chatSessionCount > 0
    };
  }

  /**
   * Check if guest has any saved chat sessions
   */
  async hasSavedChatSessions(fingerprint: string): Promise<boolean> {
    try {
      const sessions = await guestChatService.getGuestSessions(fingerprint, {
        limit: 1,
        includeMigrated: false
      });
      return sessions.length > 0;
    } catch (error) {
      console.error('Error checking saved chat sessions:', error);
      return false;
    }
  }

  /**
   * Get comprehensive guest statistics including chat data
   */
  async getComprehensiveStats(fingerprint: string): Promise<{
    usage: { current: number; max: number; remaining: number };
    chat: { sessionCount: number; lastActivity: Date | null; hasActiveChats: boolean };
    database: any;
  }> {
    const usageStats = this.getUsageStats({ req: { header: () => '' } } as any);
    const chatStats = this.getChatStats(fingerprint);

    // Get database stats for this fingerprint
    let databaseStats = null;
    try {
      databaseStats = await guestChatService.getGuestChatStats(fingerprint);
    } catch (error) {
      console.error('Error getting database chat stats:', error);
    }

    return {
      usage: {
        current: usageStats.current,
        max: usageStats.max,
        remaining: usageStats.remaining
      },
      chat: chatStats,
      database: databaseStats
    };
  }

  /**
   * Clean up guest data after successful migration
   */
  async cleanupAfterMigration(fingerprint: string): Promise<void> {
    // Reset in-memory session
    this.resetUsage(fingerprint);

    // Archive old sessions in database
    try {
      await guestChatService.archiveOldGuestSessions(fingerprint);
    } catch (error) {
      console.error('Error archiving old guest sessions:', error);
    }
  }
}

// Export singleton instance
export const guestSessionService = new GuestSessionManager();

// Export types for use in other modules
export type { GuestSession };