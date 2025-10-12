import { Hono } from "hono";
import { rateLimitMiddleware } from "./middleware/rateLimit.js";
import { uploadController } from "./controllers/uploadController.js";
import { materialController } from "./controllers/materialController.js";
import { aiController } from "./controllers/aiController.js";
import { backgroundTaskService } from "./services/backgroundTaskService.js";
import { 
  registerUser, 
  login, 
  logout, 
  getProfile, 
  updateProfile, 
  authMiddleware, 
  optionalAuthMiddleware 
} from "./controllers/authController.js";

const api = new Hono();

// Apply rate limiting to all API routes
api.use("/*", rateLimitMiddleware());

// Health check endpoint
api.get("/health", (c) =>
  c.json({
    ok: true,
    uptime: process.uptime(),
    cleanup: backgroundTaskService.getStatus(),
  })
);

// Authentication endpoints (no auth required)
api.post("/auth/register", registerUser);
api.post("/auth/login", login);
api.post("/auth/logout", logout);

// Protected authentication endpoints
api.get("/auth/profile", authMiddleware, getProfile);
api.put("/auth/profile", authMiddleware, updateProfile);

// Upload endpoints (optional auth)
api.post("/upload", optionalAuthMiddleware, (c) => uploadController.handleUpload(c));

// Material management endpoints
api.get("/material/:id", (c) => materialController.getMaterial(c));
api.post("/material/:id/remove", (c) =>
  materialController.removeFileFromMaterial(c)
);
api.delete("/material/:id", (c) => materialController.deleteMaterial(c));

// AI feature endpoints
api.post("/explain", (c) => aiController.handleAIRequest(c, "explain"));
api.post("/quiz", (c) => aiController.handleAIRequest(c, "quiz"));
api.post("/forum", (c) => aiController.handleAIRequest(c, "forum"));
api.post("/exam", (c) => aiController.handleAIRequest(c, "exam"));
api.post("/chat", (c) => aiController.handleChat(c));

// MCQ trainer endpoints
api.post("/quiz/trainer/mcq/start", (c) => aiController.generateMCQ(c));
api.post("/quiz/trainer/mcq/score", (c) => aiController.scoreMCQ(c));

// Flashcards endpoint
api.post("/flashcards", (c) => aiController.generateFlashcards(c));

// Dialogue endpoints (placeholder)
api.post("/dialogue/start", (c) => aiController.startDialogue(c));
api.post("/dialogue/step", (c) => aiController.stepDialogue(c));
api.post("/dialogue/hint", (c) => aiController.hintDialogue(c));
api.post("/dialogue/feedback", (c) => aiController.feedbackDialogue(c));

// Admin/debug endpoints
api.post("/admin/cleanup", async (c) => {
  try {
    const cleaned = await backgroundTaskService.runCleanupNow();
    return c.json({ success: true, cleaned });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  }
});

// Start background tasks
backgroundTaskService.startMaterialCleanup();

// Export cleanup stopper for graceful shutdown
export function stopBackgroundTasks(): void {
  backgroundTaskService.stopMaterialCleanup();
}

export default api;
