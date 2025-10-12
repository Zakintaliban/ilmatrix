import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createServer } from "node:net";
import api, { stopBackgroundTasks } from "./routes.js";
import config from "./config/env.js";
import { initializeDatabase, testConnection, closeDatabase } from "./services/databaseService.js";
import { validateDatabaseConfig } from "./config/database.js";

/**
 * ILMATRIX server bootstrap with improved error handling and configuration
 */
class IlmatrixServer {
  private app: Hono;
  private server: any;

  constructor() {
    this.app = new Hono();
    this.setupRoutes();
    this.setupGracefulShutdown();
  }

  /**
   * Setup application routes and middleware
   */
  private setupRoutes(): void {
    // Health check at root level
    this.app.get("/api/health", (c) =>
      c.json({
        ok: true,
        uptime: process.uptime(),
        version: process.env.npm_package_version || "unknown",
        model: config.groqModel,
        hasApiKey: !!config.groqApiKey,
      })
    );

    // Mount API routes
    this.app.route("/api", api);

    // Serve static files from public directory
    this.app.use("/*", serveStatic({ root: "./public" }));

    // Default redirect to index
    this.app.get("/", (c) => c.redirect("/index.html"));

    // 404 handler for API routes
    this.app.notFound((c) => {
      if (c.req.url.includes("/api/")) {
        return c.json({ error: "Endpoint not found" }, 404);
      }
      // For non-API routes, return 404
      return c.text("Not Found", 404);
    });

    // Global error handler
    this.app.onError((error, c) => {
      console.error("Unhandled error:", error);
      return c.json(
        {
          error: "Internal server error",
          message: config.isDevelopment ? error.message : undefined,
        },
        500
      );
    });
  }

  /**
   * Find an available port starting from the base port
   */
  private async findAvailablePort(
    startPort: number,
    maxAttempts = 10
  ): Promise<number> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const port = startPort + attempt;

      try {
        await new Promise<void>((resolve, reject) => {
          const tester = createServer()
            .once("error", reject)
            .once("listening", () => {
              tester.close(() => resolve());
            })
            .listen(port);
        });

        return port;
      } catch (error: any) {
        if (error.code !== "EADDRINUSE") {
          throw error;
        }
        // Port is in use, try next one
      }
    }

    throw new Error(
      `Could not find available port after ${maxAttempts} attempts starting from ${startPort}`
    );
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      console.log(
        `\n[ILMATRIX] Received ${signal}, shutting down gracefully...`
      );

      try {
        stopBackgroundTasks();
        console.log("[ILMATRIX] Background tasks stopped");
      } catch (error) {
        console.error("[ILMATRIX] Error stopping background tasks:", error);
      }

      try {
        await closeDatabase();
        console.log("[ILMATRIX] Database connection closed");
      } catch (error) {
        console.error("[ILMATRIX] Error closing database:", error);
      }

      if (this.server?.close) {
        this.server.close(() => {
          console.log("[ILMATRIX] Server closed");
          process.exit(0);
        });

        // Force exit after 10 seconds
        setTimeout(() => {
          console.log("[ILMATRIX] Force exit after timeout");
          process.exit(1);
        }, 10000);
      } else {
        process.exit(0);
      }
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
      console.error("[ILMATRIX] Uncaught exception:", error);
      shutdown("UNCAUGHT_EXCEPTION");
    });

    process.on("unhandledRejection", (reason, promise) => {
      console.error(
        "[ILMATRIX] Unhandled rejection at:",
        promise,
        "reason:",
        reason
      );
      // Don't exit on unhandled rejections in production
      if (config.isDevelopment) {
        shutdown("UNHANDLED_REJECTION");
      }
    });
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    try {
      // Validate configuration
      if (config.isProduction && !config.groqApiKey) {
        console.warn(
          "[ILMATRIX] Warning: GROQ_API_KEY not set in production environment"
        );
      }

      // Initialize database if configured
      if (validateDatabaseConfig()) {
        console.log("[ILMATRIX] Initializing database connection...");
        initializeDatabase();
        
        const dbConnected = await testConnection();
        if (dbConnected) {
          console.log("[ILMATRIX] Database connection established");
        } else {
          console.warn("[ILMATRIX] Database connection test failed - continuing without database");
        }
      } else {
        console.log("[ILMATRIX] No database configuration found - running without database");
      }

      // Find available port
      const port = await this.findAvailablePort(config.port);

      if (port !== config.port) {
        console.log(
          `[ILMATRIX] Port ${config.port} unavailable, using ${port} instead`
        );
      }

      // Start server
      console.log(`[ILMATRIX] Starting server...`);
      console.log(
        `[ILMATRIX] Environment: ${process.env.NODE_ENV || "development"}`
      );
      console.log(`[ILMATRIX] Model: ${config.groqModel}`);
      console.log(
        `[ILMATRIX] Material TTL: ${config.materialTtlMinutes} minutes`
      );
      console.log(
        `[ILMATRIX] Rate limit: ${config.rateLimitMax} req/min per IP`
      );

      this.server = serve({
        fetch: this.app.fetch,
        port,
        hostname: config.isDevelopment ? "localhost" : "0.0.0.0",
      });

      console.log(
        `[ILMATRIX] Server running on http://${
          config.isDevelopment ? "localhost" : "0.0.0.0"
        }:${port}`
      );
      console.log(
        `[ILMATRIX] Health check: http://localhost:${port}/api/health`
      );
      console.log(
        `[ILMATRIX] App interface: http://localhost:${port}/app.html`
      );
    } catch (error) {
      console.error("[ILMATRIX] Failed to start server:", error);
      process.exit(1);
    }
  }
}

// Start the server
const server = new IlmatrixServer();
server.start().catch((error) => {
  console.error("[ILMATRIX] Server startup failed:", error);
  process.exit(1);
});
