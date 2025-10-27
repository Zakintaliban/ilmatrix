import { Hono } from "hono";
import { rateLimitMiddleware } from "./middleware/rateLimit.js";
import { guestLimitMiddleware, strictAuthMiddleware } from "./middleware/guestLimit.js";
import { aiRateLimitMiddleware } from "./middleware/aiRateLimit.js";
import { abuseDetectionMiddleware } from "./middleware/abuseDetection.js";
import { tokenUsageMiddleware } from "./middleware/tokenUsageMiddleware.js";
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
  changePassword,
  deleteAccount,
  verifyEmailController,
  resendVerificationController,
  authMiddleware,
  optionalAuthMiddleware
} from "./controllers/authController.js";
import {
  initiateGoogleAuth,
  handleGoogleCallback
} from "./controllers/oauthController.js";
import * as dashboardController from "./controllers/dashboardController.js";
import * as guestChatController from "./controllers/guestChatController.js";
import * as usageController from "./controllers/usageController.js";

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

// OAuth endpoints
api.get("/auth/google", initiateGoogleAuth);
api.get("/auth/google/callback", handleGoogleCallback);

// Protected authentication endpoints
api.get("/auth/profile", authMiddleware, getProfile);
api.put("/auth/profile", authMiddleware, updateProfile);
api.post("/auth/change-password", authMiddleware, changePassword);
api.delete("/auth/delete-account", authMiddleware, deleteAccount);

// Dashboard endpoints (authenticated users only)
api.get("/dashboard/overview", authMiddleware, dashboardController.getDashboardOverview);

// Chat history endpoints
api.get("/dashboard/chat/sessions", authMiddleware, dashboardController.getChatSessions);
api.post("/dashboard/chat/sessions", authMiddleware, dashboardController.createChatSession);
api.get("/dashboard/chat/sessions/:sessionId/messages", authMiddleware, dashboardController.getChatMessages);
api.post("/dashboard/chat/sessions/:sessionId/messages", authMiddleware, dashboardController.addChatMessage);
api.put("/dashboard/chat/sessions/:sessionId", authMiddleware, dashboardController.updateChatSession);
api.delete("/dashboard/chat/sessions/:sessionId", authMiddleware, dashboardController.deleteChatSession);
api.post("/dashboard/chat/sessions/:sessionId/generate-title", authMiddleware, dashboardController.generateSessionTitle);

// Saved materials endpoints
api.get("/dashboard/materials", authMiddleware, dashboardController.getUserMaterials);
api.post("/dashboard/materials", authMiddleware, dashboardController.saveMaterial);
api.put("/dashboard/materials/:materialId", authMiddleware, dashboardController.updateSavedMaterial);
api.delete("/dashboard/materials/:materialId", authMiddleware, dashboardController.deleteSavedMaterial);
api.post("/dashboard/materials/:materialId/access", authMiddleware, dashboardController.recordMaterialAccess);

// Tags and filtering endpoints
api.get("/dashboard/tags", authMiddleware, dashboardController.getUserTags);
api.get("/dashboard/tags/:tag/materials", authMiddleware, dashboardController.getMaterialsByTag);

// Token usage endpoints (authenticated users only)
api.get("/usage/stats", authMiddleware, usageController.getUserStats);
api.get("/usage/history", authMiddleware, usageController.getUserHistory);
api.get("/usage/analytics", authMiddleware, usageController.getUserAnalytics);

// Admin token usage endpoints (admin only)
api.get("/admin/usage/dashboard", authMiddleware, usageController.requireAdmin, usageController.getAdminDashboard);
api.get("/admin/usage/user/:userId", authMiddleware, usageController.requireAdmin, usageController.getAdminUserDetail);
api.post("/admin/usage/user/:userId/set-admin", authMiddleware, usageController.requireAdmin, usageController.setUserAdmin);
api.post("/admin/usage/user/:userId/set-access", authMiddleware, usageController.requireAdmin, usageController.setUserTokenAccess);
api.post("/admin/usage/user/:userId/update-limits", authMiddleware, usageController.requireAdmin, usageController.updateUserLimits);
api.post("/admin/usage/reset/weekly", authMiddleware, usageController.requireAdmin, usageController.adminResetWeekly);
api.post("/admin/usage/reset/monthly", authMiddleware, usageController.requireAdmin, usageController.adminResetMonthly);
api.post("/admin/usage/cleanup/sessions", authMiddleware, usageController.requireAdmin, usageController.adminCleanupSessions);
api.post("/admin/usage/cleanup/logs", authMiddleware, usageController.requireAdmin, usageController.adminCleanupLogs);
api.get("/admin/usage/export", authMiddleware, usageController.requireAdmin, usageController.exportUsageData);

// Guest chat endpoints (no auth required - uses fingerprint)
api.get("/guest/chat/sessions", guestChatController.getGuestChatSessions);
api.post("/guest/chat/sessions", guestChatController.createGuestChatSession);
api.get("/guest/chat/sessions/:sessionId/messages", guestChatController.getGuestChatMessages);
api.post("/guest/chat/sessions/:sessionId/messages", guestChatController.addGuestChatMessage);
api.put("/guest/chat/sessions/:sessionId", guestChatController.updateGuestChatSession);
api.delete("/guest/chat/sessions/:sessionId", guestChatController.deleteGuestChatSession);
api.post("/guest/chat/sessions/:sessionId/generate-title", guestChatController.generateGuestSessionTitle);
api.get("/guest/chat/stats", guestChatController.getGuestChatStats);

// Migration endpoints (authenticated users only)
api.get("/guest/chat/pending-migration", authMiddleware, guestChatController.getPendingMigrations);
api.post("/guest/chat/migrate", authMiddleware, guestChatController.migrateGuestChats);

// Upload endpoints (optional auth)
api.post("/upload", optionalAuthMiddleware, (c) => uploadController.handleUpload(c));

// Material management endpoints
api.get("/material/:id", (c) => materialController.getMaterial(c));
api.post("/material/:id/remove", (c) =>
  materialController.removeFileFromMaterial(c)
);
api.delete("/material/:id", (c) => materialController.deleteMaterial(c));

// AI feature endpoints (with enhanced protection + token usage tracking)
// Note: optionalAuthMiddleware is implicitly used via guestLimitMiddleware
// tokenUsageMiddleware runs after auth check and only applies to registered users
api.post("/explain", optionalAuthMiddleware, tokenUsageMiddleware, guestLimitMiddleware, aiRateLimitMiddleware, abuseDetectionMiddleware, (c) => aiController.handleAIRequest(c, "explain"));
api.post("/quiz", optionalAuthMiddleware, tokenUsageMiddleware, guestLimitMiddleware, aiRateLimitMiddleware, abuseDetectionMiddleware, (c) => aiController.handleAIRequest(c, "quiz"));
api.post("/forum", optionalAuthMiddleware, tokenUsageMiddleware, guestLimitMiddleware, aiRateLimitMiddleware, abuseDetectionMiddleware, (c) => aiController.handleAIRequest(c, "forum"));
api.post("/exam", optionalAuthMiddleware, tokenUsageMiddleware, guestLimitMiddleware, aiRateLimitMiddleware, abuseDetectionMiddleware, (c) => aiController.handleAIRequest(c, "exam"));
api.post("/chat", optionalAuthMiddleware, tokenUsageMiddleware, guestLimitMiddleware, aiRateLimitMiddleware, abuseDetectionMiddleware, (c) => aiController.handleChat(c));

// MCQ trainer endpoints (with enhanced protection + token usage tracking)
api.post("/quiz/trainer/mcq/start", optionalAuthMiddleware, tokenUsageMiddleware, guestLimitMiddleware, aiRateLimitMiddleware, abuseDetectionMiddleware, (c) => aiController.generateMCQ(c));
api.post("/quiz/trainer/mcq/score", (c) => aiController.scoreMCQ(c)); // No limit for scoring

// Flashcards endpoint (with guest usage limits + token usage tracking)
api.post("/flashcards", optionalAuthMiddleware, tokenUsageMiddleware, guestLimitMiddleware, (c) => aiController.generateFlashcards(c));

// Dialogue endpoints (with guest usage limits + token usage tracking)
api.post("/dialogue/start", optionalAuthMiddleware, tokenUsageMiddleware, guestLimitMiddleware, (c) => aiController.startDialogue(c));
api.post("/dialogue/step", optionalAuthMiddleware, tokenUsageMiddleware, guestLimitMiddleware, (c) => aiController.stepDialogue(c));
api.post("/dialogue/hint", optionalAuthMiddleware, tokenUsageMiddleware, guestLimitMiddleware, (c) => aiController.hintDialogue(c));
api.post("/dialogue/feedback", optionalAuthMiddleware, tokenUsageMiddleware, guestLimitMiddleware, (c) => aiController.feedbackDialogue(c));

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
