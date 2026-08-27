import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Creates a brand-new isolated temp directory used as DATA_DIR for tests.
 * Returned path is deleted and re-created each call so every test suite starts
 * with a pristine database.
 */
export function createTestDataDir(): string {
  const root = path.join(
    os.tmpdir(),
    `pew-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}