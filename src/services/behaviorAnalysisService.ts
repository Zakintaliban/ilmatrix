import { Context } from 'hono';

/**
 * Behavioral Analysis Service
 *
 * Detects suspicious patterns and potential abuse attempts:
 * - IP hopping (VPN rotation)
 * - Rapid request patterns (automation)
 * - Bot-like behavior (perfect timing intervals)
 * - Header anomalies (inconsistent browser signals)
 * - Session manipulation attempts
 */

export type SuspiciousPattern =
  | 'IP_HOPPING'           // Frequent IP changes with same device_id
  | 'RAPID_REQUESTS'       // Too many requests in short time
  | 'BOT_TIMING'           // Perfect timing intervals (automation)
  | 'HEADER_ANOMALY'       // Inconsistent headers for same device
  | 'SESSION_MANIPULATION' // Cookie tampering attempts
  | 'EXCESSIVE_FAILURES';  // Multiple 4xx/5xx errors

export interface BehaviorEvent {
  deviceId: string;
  timestamp: Date;
  ipAddress: string;
  userAgent: string;
  endpoint: string;
  responseStatus?: number;
  timeSincePrevious?: number; // milliseconds
}

export interface SuspiciousActivity {
  deviceId: string;
  pattern: SuspiciousPattern;
  severity: 'low' | 'medium' | 'high';
  confidence: number; // 0-1
  details: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface BehaviorProfile {
  deviceId: string;
  firstSeen: Date;
  lastSeen: Date;
  requestCount: number;
  uniqueIPs: Set<string>;
  uniqueUserAgents: Set<string>;
  requestTimings: number[]; // milliseconds between requests
  endpoints: Map<string, number>; // endpoint usage count
  statusCodes: Map<number, number>; // response status counts
  recentEvents: BehaviorEvent[];
}

class BehaviorAnalysisService {
  private profiles = new Map<string, BehaviorProfile>();
  private suspiciousActivities: SuspiciousActivity[] = [];
  private readonly MAX_EVENTS_PER_PROFILE = 50;
  private readonly MAX_SUSPICIOUS_ACTIVITIES = 1000;

  // Thresholds for detection
  private readonly THRESHOLDS = {
    IP_HOPPING: {
      uniqueIPs: 3,           // 3+ different IPs
      timeWindow: 3600000,    // within 1 hour
      minRequests: 5          // with 5+ requests
    },
    RAPID_REQUESTS: {
      maxRequests: 10,        // 10+ requests
      timeWindow: 60000,      // within 1 minute
    },
    BOT_TIMING: {
      perfectInterval: 100,   // requests within 100ms of each other
      minOccurrences: 3,      // 3+ times
      tolerance: 50           // ±50ms tolerance
    },
    HEADER_ANOMALY: {
      maxUniqueUA: 3,         // 3+ different user agents
      timeWindow: 3600000     // within 1 hour
    },
    EXCESSIVE_FAILURES: {
      maxFailures: 5,         // 5+ failures
      timeWindow: 300000      // within 5 minutes
    }
  };

  /**
   * Track a request for behavioral analysis
   */
  trackRequest(
    deviceId: string,
    c: Context,
    endpoint: string,
    responseStatus?: number
  ): void {
    const now = new Date();
    const ipAddress = this.getClientIP(c);
    const userAgent = c.req.header('user-agent') || 'unknown';

    // Get or create profile
    let profile = this.profiles.get(deviceId);
    if (!profile) {
      profile = {
        deviceId,
        firstSeen: now,
        lastSeen: now,
        requestCount: 0,
        uniqueIPs: new Set(),
        uniqueUserAgents: new Set(),
        requestTimings: [],
        endpoints: new Map(),
        statusCodes: new Map(),
        recentEvents: []
      };
      this.profiles.set(deviceId, profile);
    }

    // Calculate timing since last request
    let timeSincePrevious: number | undefined;
    if (profile.recentEvents.length > 0) {
      const lastEvent = profile.recentEvents[profile.recentEvents.length - 1];
      timeSincePrevious = now.getTime() - lastEvent.timestamp.getTime();
      profile.requestTimings.push(timeSincePrevious);
    }

    // Create event
    const event: BehaviorEvent = {
      deviceId,
      timestamp: now,
      ipAddress,
      userAgent,
      endpoint,
      responseStatus,
      timeSincePrevious
    };

    // Update profile
    profile.lastSeen = now;
    profile.requestCount++;
    profile.uniqueIPs.add(ipAddress);
    profile.uniqueUserAgents.add(userAgent);
    profile.endpoints.set(endpoint, (profile.endpoints.get(endpoint) || 0) + 1);
    if (responseStatus) {
      profile.statusCodes.set(responseStatus, (profile.statusCodes.get(responseStatus) || 0) + 1);
    }

    // Add event to recent events (keep last N)
    profile.recentEvents.push(event);
    if (profile.recentEvents.length > this.MAX_EVENTS_PER_PROFILE) {
      profile.recentEvents.shift();
    }

    // Analyze for suspicious patterns
    this.analyzeProfile(profile);
  }

  /**
   * Analyze profile for suspicious patterns
   */
  private analyzeProfile(profile: BehaviorProfile): void {
    const now = new Date();

    // 1. IP Hopping Detection
    if (profile.uniqueIPs.size >= this.THRESHOLDS.IP_HOPPING.uniqueIPs) {
      const recentIPs = new Set(
        profile.recentEvents
          .filter(e => now.getTime() - e.timestamp.getTime() < this.THRESHOLDS.IP_HOPPING.timeWindow)
          .map(e => e.ipAddress)
      );

      if (recentIPs.size >= this.THRESHOLDS.IP_HOPPING.uniqueIPs &&
          profile.requestCount >= this.THRESHOLDS.IP_HOPPING.minRequests) {
        this.recordSuspiciousActivity({
          deviceId: profile.deviceId,
          pattern: 'IP_HOPPING',
          severity: 'high',
          confidence: Math.min(recentIPs.size / 5, 1),
          details: `Device accessed from ${recentIPs.size} different IPs in last hour`,
          timestamp: now,
          metadata: { uniqueIPs: Array.from(recentIPs) }
        });
      }
    }

    // 2. Rapid Requests Detection
    const recentRequests = profile.recentEvents.filter(
      e => now.getTime() - e.timestamp.getTime() < this.THRESHOLDS.RAPID_REQUESTS.timeWindow
    );

    if (recentRequests.length >= this.THRESHOLDS.RAPID_REQUESTS.maxRequests) {
      this.recordSuspiciousActivity({
        deviceId: profile.deviceId,
        pattern: 'RAPID_REQUESTS',
        severity: 'medium',
        confidence: Math.min(recentRequests.length / 15, 1),
        details: `${recentRequests.length} requests in last minute`,
        timestamp: now,
        metadata: { requestCount: recentRequests.length }
      });
    }

    // 3. Bot Timing Detection (perfect intervals)
    if (profile.requestTimings.length >= this.THRESHOLDS.BOT_TIMING.minOccurrences) {
      const recentTimings = profile.requestTimings.slice(-10); // last 10 intervals
      const avgInterval = recentTimings.reduce((a, b) => a + b, 0) / recentTimings.length;

      // Check if intervals are suspiciously consistent
      const deviations = recentTimings.map(t => Math.abs(t - avgInterval));
      const avgDeviation = deviations.reduce((a, b) => a + b, 0) / deviations.length;

      if (avgDeviation < this.THRESHOLDS.BOT_TIMING.tolerance && recentTimings.length >= 5) {
        this.recordSuspiciousActivity({
          deviceId: profile.deviceId,
          pattern: 'BOT_TIMING',
          severity: 'high',
          confidence: 1 - (avgDeviation / this.THRESHOLDS.BOT_TIMING.tolerance),
          details: `Requests have suspiciously consistent timing (avg ${avgInterval.toFixed(0)}ms ±${avgDeviation.toFixed(0)}ms)`,
          timestamp: now,
          metadata: { avgInterval, avgDeviation, timings: recentTimings }
        });
      }
    }

    // 4. Header Anomaly Detection
    if (profile.uniqueUserAgents.size >= this.THRESHOLDS.HEADER_ANOMALY.maxUniqueUA) {
      const recentUAs = new Set(
        profile.recentEvents
          .filter(e => now.getTime() - e.timestamp.getTime() < this.THRESHOLDS.HEADER_ANOMALY.timeWindow)
          .map(e => e.userAgent)
      );

      if (recentUAs.size >= this.THRESHOLDS.HEADER_ANOMALY.maxUniqueUA) {
        this.recordSuspiciousActivity({
          deviceId: profile.deviceId,
          pattern: 'HEADER_ANOMALY',
          severity: 'medium',
          confidence: Math.min(recentUAs.size / 5, 1),
          details: `Device used ${recentUAs.size} different user agents in last hour`,
          timestamp: now,
          metadata: { uniqueUserAgents: Array.from(recentUAs) }
        });
      }
    }

    // 5. Excessive Failures Detection
    const recentFailures = profile.recentEvents.filter(
      e => e.responseStatus && e.responseStatus >= 400 &&
           now.getTime() - e.timestamp.getTime() < this.THRESHOLDS.EXCESSIVE_FAILURES.timeWindow
    );

    if (recentFailures.length >= this.THRESHOLDS.EXCESSIVE_FAILURES.maxFailures) {
      this.recordSuspiciousActivity({
        deviceId: profile.deviceId,
        pattern: 'EXCESSIVE_FAILURES',
        severity: 'low',
        confidence: Math.min(recentFailures.length / 10, 1),
        details: `${recentFailures.length} failed requests in last 5 minutes`,
        timestamp: now,
        metadata: { failureCount: recentFailures.length }
      });
    }
  }

  /**
   * Record suspicious activity with deduplication
   */
  private recordSuspiciousActivity(activity: SuspiciousActivity): void {
    // Deduplicate: don't record same pattern for same device within 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const isDuplicate = this.suspiciousActivities.some(
      existing =>
        existing.deviceId === activity.deviceId &&
        existing.pattern === activity.pattern &&
        existing.timestamp > fiveMinutesAgo
    );

    if (isDuplicate) {
      return; // Skip duplicate
    }

    this.suspiciousActivities.push(activity);

    // Limit array size
    if (this.suspiciousActivities.length > this.MAX_SUSPICIOUS_ACTIVITIES) {
      this.suspiciousActivities.shift();
    }

    // Log alert
    this.alertSuspiciousActivity(activity);
  }

  /**
   * Alert on suspicious activity (console + optional webhook)
   */
  private alertSuspiciousActivity(activity: SuspiciousActivity): void {
    const emoji = activity.severity === 'high' ? '🚨' : activity.severity === 'medium' ? '⚠️' : '📊';

    console.warn(
      `${emoji} SUSPICIOUS ACTIVITY DETECTED\n` +
      `  Pattern: ${activity.pattern}\n` +
      `  Severity: ${activity.severity.toUpperCase()}\n` +
      `  Confidence: ${(activity.confidence * 100).toFixed(0)}%\n` +
      `  Device: ${activity.deviceId.substring(0, 8)}...\n` +
      `  Details: ${activity.details}\n` +
      `  Time: ${activity.timestamp.toISOString()}`
    );

    // TODO: Send to webhook/monitoring service if configured
    // if (process.env.ALERT_WEBHOOK_URL) {
    //   fetch(process.env.ALERT_WEBHOOK_URL, {
    //     method: 'POST',
    //     headers: { 'Content-Type': 'application/json' },
    //     body: JSON.stringify(activity)
    //   }).catch(err => console.error('Alert webhook failed:', err));
    // }
  }

  /**
   * Get client IP with proxy support
   */
  private getClientIP(c: Context): string {
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }

    const realIP = c.req.header('x-real-ip');
    if (realIP) {
      return realIP;
    }

    return 'unknown';
  }

  /**
   * Check if device is currently flagged as suspicious
   */
  isSuspicious(deviceId: string, within: number = 3600000): boolean {
    const threshold = new Date(Date.now() - within);
    return this.suspiciousActivities.some(
      activity =>
        activity.deviceId === deviceId &&
        activity.timestamp > threshold &&
        activity.severity !== 'low'
    );
  }

  /**
   * Get suspicious activity for a device
   */
  getSuspiciousActivity(deviceId: string, limit: number = 10): SuspiciousActivity[] {
    return this.suspiciousActivities
      .filter(a => a.deviceId === deviceId)
      .slice(-limit)
      .reverse();
  }

  /**
   * Get all recent suspicious activities
   */
  getRecentSuspiciousActivities(limit: number = 50): SuspiciousActivity[] {
    return this.suspiciousActivities
      .slice(-limit)
      .reverse();
  }

  /**
   * Get behavior profile for a device
   */
  getProfile(deviceId: string): BehaviorProfile | undefined {
    return this.profiles.get(deviceId);
  }

  /**
   * Get statistics for monitoring
   */
  getStats(): {
    totalProfiles: number;
    totalSuspiciousActivities: number;
    recentAlerts: {
      last5min: number;
      last1hour: number;
      last24hours: number;
    };
    patternBreakdown: Record<SuspiciousPattern, number>;
    topSuspiciousDevices: Array<{ deviceId: string; alertCount: number }>;
  } {
    const now = Date.now();
    const fiveMin = now - 5 * 60 * 1000;
    const oneHour = now - 60 * 60 * 1000;
    const twentyFourHours = now - 24 * 60 * 60 * 1000;

    const patternBreakdown: Record<string, number> = {};
    const deviceAlertCounts = new Map<string, number>();

    for (const activity of this.suspiciousActivities) {
      const time = activity.timestamp.getTime();

      // Pattern breakdown
      patternBreakdown[activity.pattern] = (patternBreakdown[activity.pattern] || 0) + 1;

      // Device alert counts
      deviceAlertCounts.set(
        activity.deviceId,
        (deviceAlertCounts.get(activity.deviceId) || 0) + 1
      );
    }

    const topSuspiciousDevices = Array.from(deviceAlertCounts.entries())
      .map(([deviceId, alertCount]) => ({ deviceId, alertCount }))
      .sort((a, b) => b.alertCount - a.alertCount)
      .slice(0, 10);

    return {
      totalProfiles: this.profiles.size,
      totalSuspiciousActivities: this.suspiciousActivities.length,
      recentAlerts: {
        last5min: this.suspiciousActivities.filter(a => a.timestamp.getTime() > fiveMin).length,
        last1hour: this.suspiciousActivities.filter(a => a.timestamp.getTime() > oneHour).length,
        last24hours: this.suspiciousActivities.filter(a => a.timestamp.getTime() > twentyFourHours).length
      },
      patternBreakdown: patternBreakdown as Record<SuspiciousPattern, number>,
      topSuspiciousDevices
    };
  }

  /**
   * Cleanup old data
   */
  cleanup(maxAge: number = 24 * 60 * 60 * 1000): { profilesCleaned: number; activitiesCleaned: number } {
    const threshold = new Date(Date.now() - maxAge);
    let profilesCleaned = 0;
    let activitiesCleaned = 0;

    // Cleanup old profiles
    for (const [deviceId, profile] of this.profiles.entries()) {
      if (profile.lastSeen < threshold) {
        this.profiles.delete(deviceId);
        profilesCleaned++;
      }
    }

    // Cleanup old activities
    const originalLength = this.suspiciousActivities.length;
    this.suspiciousActivities = this.suspiciousActivities.filter(
      a => a.timestamp > threshold
    );
    activitiesCleaned = originalLength - this.suspiciousActivities.length;

    console.log(
      `Behavior analysis cleanup: removed ${profilesCleaned} profiles, ${activitiesCleaned} activities`
    );

    return { profilesCleaned, activitiesCleaned };
  }
}

// Export singleton
export const behaviorAnalysisService = new BehaviorAnalysisService();
