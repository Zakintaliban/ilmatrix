/**
 * Charge AI quota reservations the server never finished (crash, lost
 * instance) in full, then exit.
 *
 *   npm run quota:expire
 *
 * For hosts where the in-process sweep isn't reliable (Cloud Run throttles CPU
 * between requests and stops idle instances): run it as a Cloud Run Job
 * triggered by Cloud Scheduler, which calls the Jobs API with IAM, so nothing
 * is exposed over HTTP. Safe to run anywhere, any number of times, alongside
 * the app: each reservation is expired once. Exits non-zero on failure.
 */
import { expireStale } from "../src/services/quotaService.js";
import { closeDatabase } from "../src/services/databaseService.js";

try {
  const expired = await expireStale();
  console.log(`[QUOTA] Expired ${expired} reservation(s)`);
} catch (error) {
  console.error("[QUOTA] Expiry failed:", error);
  process.exitCode = 1;
} finally {
  await closeDatabase().catch(() => {});
}
