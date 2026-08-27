import { getDb } from "./db";
import { bootstrapAdmin } from "./users";
import { deleteExpiredSessions } from "./users";

/**
 * Runs once at server startup: migrates the schema, bootstraps the initial
 * admin from env vars (only when no admin exists), and prunes expired sessions.
 */
export function initializeApp(): void {
  getDb(); // ensures schema + WAL setup
  bootstrapAdmin();
  deleteExpiredSessions();
}