import path from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Central configuration. All persistent paths are derived from DATA_DIR so the
 * whole application can be backed up by backing up a single directory.
 */
export interface AppConfig {
  dataDir: string;
  dbPath: string;
  attachmentsDir: string;
  thumbnailsDir: string;
  adminUsername: string | undefined;
  adminPassword: string | undefined;
  sessionSecret: string;
  port: number;
}

function resolveDataDir(): string {
  return path.resolve(process.env.DATA_DIR || "./data");
}

export function loadConfig(): AppConfig {
  const dataDir = resolveDataDir();
  const dbPath = path.join(dataDir, "app.db");
  const attachmentsDir = path.join(dataDir, "attachments");
  const thumbnailsDir = path.join(dataDir, "thumbnails");

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(attachmentsDir, { recursive: true });
  mkdirSync(thumbnailsDir, { recursive: true });

  const isProd = process.env.NODE_ENV === "production";
  const adminUsername = process.env.ADMIN_USERNAME || (isProd ? undefined : "admin");
  const adminPassword = process.env.ADMIN_PASSWORD || (isProd ? undefined : "admin1234!");

  return {
    dataDir,
    dbPath,
    attachmentsDir,
    thumbnailsDir,
    adminUsername,
    adminPassword,
    sessionSecret:
      process.env.SESSION_SECRET ||
      `pew-default-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    port: Number(process.env.PORT || 3000),
  };
}

let cached: AppConfig | undefined;
export function config(): AppConfig {
  if (!cached) {
    cached = loadConfig();
  }
  return cached;
}

export function resetConfig(): void {
  cached = undefined;
}