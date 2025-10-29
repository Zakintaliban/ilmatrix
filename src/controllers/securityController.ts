import { Context } from 'hono';
import { behaviorAnalysisService } from '../services/behaviorAnalysisService.js';
import { guestSessionService } from '../services/guestSessionService.js';

/**
 * Security monitoring controller
 * Provides endpoints for monitoring suspicious activities and behavioral patterns
 */

/**
 * Get recent suspicious activities
 */
export async function getRecentSuspiciousActivities(c: Context) {
  try {
    const limit = parseInt(c.req.query('limit') || '50');
    const activities = behaviorAnalysisService.getRecentSuspiciousActivities(limit);

    return c.json({
      total: activities.length,
      activities: activities.map(a => ({
        deviceId: a.deviceId.substring(0, 8) + '...',  // Truncate for privacy
        pattern: a.pattern,
        severity: a.severity,
        confidence: a.confidence,
        details: a.details,
        timestamp: a.timestamp,
        metadata: a.metadata
      }))
    });
  } catch (error) {
    console.error('Error getting suspicious activities:', error);
    return c.json({ error: 'Failed to retrieve suspicious activities' }, 500);
  }
}

/**
 * Get suspicious activities for a specific device
 */
export async function getDeviceSuspiciousActivities(c: Context) {
  try {
    const deviceId = c.req.param('deviceId');
    if (!deviceId) {
      return c.json({ error: 'Device ID required' }, 400);
    }

    const activities = behaviorAnalysisService.getSuspiciousActivity(deviceId);
    const profile = behaviorAnalysisService.getProfile(deviceId);

    return c.json({
      deviceId: deviceId.substring(0, 8) + '...',
      isSuspicious: behaviorAnalysisService.isSuspicious(deviceId),
      profile: profile ? {
        firstSeen: profile.firstSeen,
        lastSeen: profile.lastSeen,
        requestCount: profile.requestCount,
        uniqueIPs: profile.uniqueIPs.size,
        uniqueUserAgents: profile.uniqueUserAgents.size,
        endpoints: Object.fromEntries(profile.endpoints),
        statusCodes: Object.fromEntries(profile.statusCodes)
      } : null,
      activities: activities.map(a => ({
        pattern: a.pattern,
        severity: a.severity,
        confidence: a.confidence,
        details: a.details,
        timestamp: a.timestamp,
        metadata: a.metadata
      }))
    });
  } catch (error) {
    console.error('Error getting device activities:', error);
    return c.json({ error: 'Failed to retrieve device activities' }, 500);
  }
}

/**
 * Get comprehensive security statistics
 */
export async function getSecurityStats(c: Context) {
  try {
    const behaviorStats = behaviorAnalysisService.getStats();
    const guestStats = guestSessionService.getStats();

    return c.json({
      timestamp: new Date(),
      guestSessions: {
        total: guestStats.totalSessions,
        active: guestStats.activeSessions,
        expired: guestStats.expiredSessions,
        usageDistribution: guestStats.usageDistribution
      },
      behaviorAnalysis: {
        totalProfiles: behaviorStats.totalProfiles,
        totalSuspiciousActivities: behaviorStats.totalSuspiciousActivities,
        recentAlerts: behaviorStats.recentAlerts,
        patternBreakdown: behaviorStats.patternBreakdown,
        topSuspiciousDevices: behaviorStats.topSuspiciousDevices.map(d => ({
          deviceId: d.deviceId.substring(0, 8) + '...',
          alertCount: d.alertCount
        }))
      }
    });
  } catch (error) {
    console.error('Error getting security stats:', error);
    return c.json({ error: 'Failed to retrieve security stats' }, 500);
  }
}

/**
 * Get detailed report for a specific pattern type
 */
export async function getPatternReport(c: Context) {
  try {
    const pattern = c.req.param('pattern');
    if (!pattern) {
      return c.json({ error: 'Pattern type required' }, 400);
    }

    const allActivities = behaviorAnalysisService.getRecentSuspiciousActivities(1000);
    const patternActivities = allActivities.filter(a => a.pattern === pattern);

    // Group by device
    const deviceMap = new Map<string, any[]>();
    for (const activity of patternActivities) {
      if (!deviceMap.has(activity.deviceId)) {
        deviceMap.set(activity.deviceId, []);
      }
      deviceMap.get(activity.deviceId)!.push(activity);
    }

    const devices = Array.from(deviceMap.entries()).map(([deviceId, activities]) => ({
      deviceId: deviceId.substring(0, 8) + '...',
      occurrences: activities.length,
      firstDetected: activities[activities.length - 1].timestamp,
      lastDetected: activities[0].timestamp,
      avgConfidence: activities.reduce((sum, a) => sum + a.confidence, 0) / activities.length
    }));

    return c.json({
      pattern,
      totalOccurrences: patternActivities.length,
      uniqueDevices: devices.length,
      devices: devices.sort((a, b) => b.occurrences - a.occurrences)
    });
  } catch (error) {
    console.error('Error getting pattern report:', error);
    return c.json({ error: 'Failed to retrieve pattern report' }, 500);
  }
}
