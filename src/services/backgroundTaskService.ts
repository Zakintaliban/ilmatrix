import { materialService } from "../services/materialService.js";
import { guestSessionService } from "../services/guestSessionService.js";
import config from "../config/env.js";

/**
 * Service for managing background tasks like cleanup operations
 */
export class BackgroundTaskService {
  private cleanupInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  /**
   * Start the material cleanup task
   */
  startMaterialCleanup(): void {
    if (this.isRunning) {
      console.warn("Material cleanup is already running");
      return;
    }

    const intervalMs = Math.max(
      60_000, // Minimum 1 minute
      (config.materialTtlMinutes * 60_000) / 4 // Run 4 times per TTL period
    );

    console.log(
      `Starting material cleanup task (interval: ${Math.round(
        intervalMs / 1000
      )}s, TTL: ${config.materialTtlMinutes}min)`
    );

    this.cleanupInterval = setInterval(async () => {
      try {
        // Cleanup old materials
        const materialsCleaned = await materialService.cleanupOldMaterials();
        
        // Cleanup expired guest sessions
        const guestSessionsResult = guestSessionService.cleanupExpiredSessions();
        
        if (materialsCleaned > 0 || guestSessionsResult.cleaned > 0) {
          console.log(`Background cleanup: ${materialsCleaned} old materials, ${guestSessionsResult.cleaned} guest sessions cleaned`);
        }
      } catch (error) {
        console.error("Error during background cleanup:", error);
      }
    }, intervalMs);

    // Allow Node.js to exit if this is the only thing keeping the process alive
    this.cleanupInterval.unref();

    this.isRunning = true;
  }

  /**
   * Stop the material cleanup task
   */
  stopMaterialCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      this.isRunning = false;
      console.log("Stopped material cleanup task");
    }
  }

  /**
   * Run cleanup immediately
   */
  async runCleanupNow(): Promise<{ materials: number; guestSessions: number }> {
    try {
      const materialsCleaned = await materialService.cleanupOldMaterials();
      const guestSessionsResult = guestSessionService.cleanupExpiredSessions();
      
      console.log(`Manual cleanup completed: ${materialsCleaned} materials removed, ${guestSessionsResult.cleaned} guest sessions cleaned`);
      
      return {
        materials: materialsCleaned,
        guestSessions: guestSessionsResult.cleaned
      };
    } catch (error) {
      console.error("Error during manual cleanup:", error);
      throw error;
    }
  }

  /**
   * Get cleanup status
   */
  getStatus(): { running: boolean; intervalMs?: number; ttlMinutes: number } {
    return {
      running: this.isRunning,
      intervalMs: this.cleanupInterval
        ? (config.materialTtlMinutes * 60_000) / 4
        : undefined,
      ttlMinutes: config.materialTtlMinutes,
    };
  }
}

// Export singleton instance
export const backgroundTaskService = new BackgroundTaskService();
