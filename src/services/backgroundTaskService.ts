import { materialService } from "../services/materialService.js";
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
        const cleaned = await materialService.cleanupOldMaterials();
        if (cleaned > 0) {
          console.log(`Cleaned up ${cleaned} old material files`);
        }
      } catch (error) {
        console.error("Error during material cleanup:", error);
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
  async runCleanupNow(): Promise<number> {
    try {
      const cleaned = await materialService.cleanupOldMaterials();
      console.log(`Manual cleanup completed: ${cleaned} files removed`);
      return cleaned;
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
