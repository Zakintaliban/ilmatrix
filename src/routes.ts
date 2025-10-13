import { Hono } from "hono";
import { rateLimitMiddleware } from "./middleware/rateLimit.js";
import { guestLimitMiddleware, strictAuthMiddleware } from "./middleware/guestLimit.js";
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
  verifyEmailController,
  resendVerificationController,
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
api.get("/auth/verify-email", verifyEmailController);
api.post("/auth/resend-verification", resendVerificationController);

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

// AI feature endpoints (with guest usage limits)
api.post("/explain", guestLimitMiddleware, (c) => aiController.handleAIRequest(c, "explain"));
api.post("/quiz", guestLimitMiddleware, (c) => aiController.handleAIRequest(c, "quiz"));
api.post("/forum", guestLimitMiddleware, (c) => aiController.handleAIRequest(c, "forum"));
api.post("/exam", guestLimitMiddleware, (c) => aiController.handleAIRequest(c, "exam"));
api.post("/chat", guestLimitMiddleware, (c) => aiController.handleChat(c));

// MCQ trainer endpoints (with guest usage limits)
api.post("/quiz/trainer/mcq/start", guestLimitMiddleware, (c) => aiController.generateMCQ(c));
api.post("/quiz/trainer/mcq/score", (c) => aiController.scoreMCQ(c)); // No limit for scoring

// Flashcards endpoint (with guest usage limits)
api.post("/flashcards", guestLimitMiddleware, (c) => aiController.generateFlashcards(c));

// Dialogue endpoints (with guest usage limits)
api.post("/dialogue/start", guestLimitMiddleware, (c) => aiController.startDialogue(c));
api.post("/dialogue/step", guestLimitMiddleware, (c) => aiController.stepDialogue(c));
api.post("/dialogue/hint", guestLimitMiddleware, (c) => aiController.hintDialogue(c));
api.post("/dialogue/feedback", guestLimitMiddleware, (c) => aiController.feedbackDialogue(c));

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
