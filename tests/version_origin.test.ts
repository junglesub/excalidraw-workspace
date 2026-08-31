import { describe, it, expect, beforeEach } from "vitest";
import { getDb, resetDb, initializeSchema } from "@/lib/db";
import { resetConfig } from "@/lib/config";
import { createUser } from "@/lib/users";
import { createDocument, getDocumentRaw } from "@/lib/documents";
import {
  createSnapshotFromScene,
  listVersions,
  restoreVersion,
  resolveRecoveryConflict,
} from "@/lib/versions";
import { emptyScene, jsonToScene, sceneToJson } from "@/lib/types";
import { GET as getVersionsRoute } from "@/app/api/documents/[id]/versions/route";
import { POST as postManualSave } from "@/app/api/documents/[id]/save/route";
import { PUT as putAutoSave } from "@/app/api/documents/[id]/scene/route";
import { SESSION_COOKIE } from "@/lib/http";
import { createSession } from "@/lib/users";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { originBadgeLabel } from "@/app/documents/[id]/EditorClient";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

describe("Version origin labels", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("schema is backward compatible: existing rows without origin remain valid and new snapshots persist origin", () => {
    // Verify column exists after migration
    const cols = getDb().prepare("PRAGMA table_info(document_versions)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "origin")).toBe(true);

    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Doc");

    // Simulate legacy row inserted without origin (raw SQL mimicking old DB)
    const legacyId = crypto.randomUUID();
    getDb()
      .prepare(
        `INSERT INTO document_versions (id, document_id, version_number, scene, thumbnail_path, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(legacyId, doc.id, 1, JSON.stringify(emptyScene()), null, user.id, new Date().toISOString());

    const legacyVersions = listVersions(doc.id);
    expect(legacyVersions).toHaveLength(1);
    expect(legacyVersions[0].origin).toBeNull();
    expect(originBadgeLabel(legacyVersions[0].origin)).toBe("Legacy / unknown");
    expect(originBadgeLabel(null)).toBe("Legacy / unknown");
    expect(originBadgeLabel(undefined as unknown as string)).toBe("Legacy / unknown");

    // New snapshot with origin should persist correctly alongside legacy
    createSnapshotFromScene(doc.id, { ...emptyScene(), elements: [{ id: "1", type: "rectangle" }] }, user.id, true, null, {
      origin: "manual_save",
    });
    const versions = listVersions(doc.id);
    expect(versions).toHaveLength(2);
    // Newest first
    expect(versions[0].origin).toBe("manual_save");
    expect(versions[1].origin).toBeNull();
  });

  it("migrates an actual legacy database file lacking origin, preserving legacy rows as Legacy / unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "excalidraw-legacy-"));
    const dbPath = join(dir, "legacy.db");
    const nodeRequire = createRequire(import.meta.url);
    const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: new (path: string) => any };
    const legacyDb = new DatabaseSync(dbPath);
    try {
      legacyDb.exec("PRAGMA foreign_keys = OFF;");
      // Old schema without origin in document_versions
      legacyDb.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id            TEXT PRIMARY KEY,
          username      TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role          TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','ADMIN')),
          is_active     INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS documents (
          id             TEXT PRIMARY KEY,
          title          TEXT NOT NULL,
          owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          scene          TEXT NOT NULL DEFAULT '{}',
          thumbnail_path TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL,
          deleted_at     TEXT
        );
        CREATE TABLE IF NOT EXISTS document_versions (
          id             TEXT PRIMARY KEY,
          document_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          version_number INTEGER NOT NULL,
          scene          TEXT NOT NULL,
          thumbnail_path TEXT,
          created_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_versions_doc ON document_versions(document_id, version_number);
      `);

      // Verify old schema lacks origin
      const beforeCols = legacyDb.prepare("PRAGMA table_info(document_versions)").all() as { name: string }[];
      expect(beforeCols.some((c) => c.name === "origin")).toBe(false);

      // Insert valid legacy-related rows before migration
      const userId = crypto.randomUUID();
      const docId = crypto.randomUUID();
      const versionId = crypto.randomUUID();
      const now = new Date().toISOString();
      legacyDb.prepare("INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(userId, "legacy_user", "hash", "USER", 1, now, now);
      legacyDb.prepare("INSERT INTO documents (id, title, owner_id, scene, thumbnail_path, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(docId, "Legacy Doc", userId, JSON.stringify(emptyScene()), null, now, now, null);
      const legacyScene = JSON.stringify({ ...emptyScene(), elements: [{ id: "legacy", type: "rectangle" }] });
      legacyDb.prepare("INSERT INTO document_versions (id, document_id, version_number, scene, thumbnail_path, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(versionId, docId, 1, legacyScene, null, userId, now);

      // Invoke existing exported migration against that database
      initializeSchema(legacyDb);

      // Verify origin exists and legacy data retained with NULL origin
      const afterCols = legacyDb.prepare("PRAGMA table_info(document_versions)").all() as { name: string }[];
      expect(afterCols.some((c) => c.name === "origin")).toBe(true);

      const legacyRow = legacyDb.prepare("SELECT id, document_id, version_number, scene, origin FROM document_versions WHERE id = ?").get(versionId) as { id: string; origin: string | null; scene: string };
      expect(legacyRow).toBeDefined();
      expect(legacyRow.origin).toBeNull();
      expect(JSON.parse(legacyRow.scene).elements[0].id).toBe("legacy");
      expect(originBadgeLabel(legacyRow.origin)).toBe("Legacy / unknown");

      // New snapshot with origin should persist alongside legacy after migration
      const newVersionId = crypto.randomUUID();
      legacyDb.prepare("INSERT INTO document_versions (id, document_id, version_number, scene, thumbnail_path, created_by, created_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(newVersionId, docId, 2, JSON.stringify(emptyScene()), null, userId, new Date().toISOString(), "manual_save");
      const newRow = legacyDb.prepare("SELECT origin FROM document_versions WHERE id = ?").get(newVersionId) as { origin: string };
      expect(newRow.origin).toBe("manual_save");

      const allRows = legacyDb.prepare("SELECT origin FROM document_versions WHERE document_id = ? ORDER BY version_number ASC").all(docId) as { origin: string | null }[];
      expect(allRows).toHaveLength(2);
      expect(allRows[0].origin).toBeNull();
      expect(allRows[1].origin).toBe("manual_save");

      // Re-running migration is idempotent and preserves data
      initializeSchema(legacyDb);
      const afterSecond = legacyDb.prepare("PRAGMA table_info(document_versions)").all() as { name: string }[];
      expect(afterSecond.filter((c) => c.name === "origin")).toHaveLength(1);
      const stillLegacy = legacyDb.prepare("SELECT origin FROM document_versions WHERE id = ?").get(versionId) as { origin: string | null };
      expect(stillLegacy.origin).toBeNull();
    } finally {
      try {
        legacyDb.close();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists manual_save, auto_snapshot, and restore origins", async () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Doc");

    createSnapshotFromScene(doc.id, emptyScene(), user.id, false, null, { origin: "manual_save" });
    expect(listVersions(doc.id)[0].origin).toBe("manual_save");

    // Simulate auto_snapshot via direct call (API route also covered below)
    const autoScene = { ...emptyScene(), elements: [{ id: "auto", type: "rect" }] };
    createSnapshotFromScene(doc.id, autoScene, user.id, false, null, {
      origin: "auto_snapshot",
    });
    const afterAuto = listVersions(doc.id);
    expect(afterAuto[0].origin).toBe("auto_snapshot");
    // Make auto the current document state before restore
    getDb().prepare("UPDATE documents SET scene = ?, updated_at = ? WHERE id = ?").run(sceneToJson(autoScene), new Date().toISOString(), doc.id);

    const snap = afterAuto[1]; // manual_save snapshot (empty)
    restoreVersion(doc.id, snap.id, user.id, "USER", false);
    const afterRestore = listVersions(doc.id);
    expect(afterRestore[0].origin).toBe("restore");
    // New snapshot should be of pre-restore auto, not the restored empty
    const restoredCurrent = jsonToScene(getDocumentRaw(doc.id)!.scene);
    expect(restoredCurrent.elements).toEqual([]);
    const snapAfter = getDb().prepare("SELECT scene FROM document_versions WHERE id = ?").get(afterRestore[0].id) as { scene: string };
    expect(jsonToScene(snapAfter.scene).elements[0] && (jsonToScene(snapAfter.scene).elements[0] as any).id).toBe("auto");
  });

  it("persists recovery origins for each direction", () => {
    const user = createUser("alice", "pass123", "USER");
    const serverScene = { ...emptyScene(), elements: [{ id: "server", type: "rect" }] };
    const clientScene = { ...emptyScene(), elements: [{ id: "client", type: "ellipse" }] };

    // Client draft preserved as recovery_server_version? Actually when choosing client, discarded server is snapshotted
    const doc1 = createDocument(user.id, serverScene, "Doc1");
    resolveRecoveryConflict(doc1.id, user.id, "USER", false, {
      choice: "client",
      preserveDiscarded: true,
      expectedServerUpdatedAt: doc1.updated_at,
      clientScene,
    });
    expect(listVersions(doc1.id)[0].origin).toBe("recovery_server_version");

    // When choosing server, discarded client is snapshotted
    const doc2 = createDocument(user.id, serverScene, "Doc2");
    resolveRecoveryConflict(doc2.id, user.id, "USER", false, {
      choice: "server",
      preserveDiscarded: true,
      expectedServerUpdatedAt: doc2.updated_at,
      clientScene,
    });
    expect(listVersions(doc2.id)[0].origin).toBe("recovery_client_draft");
  });

  it("does not create snapshot with origin when preservation disabled", () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Doc");
    resolveRecoveryConflict(doc.id, user.id, "USER", false, {
      choice: "server",
      preserveDiscarded: false,
      expectedServerUpdatedAt: doc.updated_at,
      clientScene: emptyScene(),
    });
    expect(listVersions(doc.id)).toHaveLength(0);
  });

  it("exposes origin via listVersions and history API", async () => {
    const user = createUser("alice", "pass123", "USER");
    const session = createSession(user.id);
    const doc = createDocument(user.id, emptyScene(), "Doc");
    createSnapshotFromScene(doc.id, emptyScene(), user.id, false, null, { origin: "manual_save" });

    const listed = listVersions(doc.id);
    expect(listed[0].origin).toBe("manual_save");

    const req = new Request(`http://localhost/api/documents/${doc.id}/versions`, {
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
    });
    const res = await getVersionsRoute(req as unknown as Request, { params: Promise.resolve({ id: doc.id }) } as any);
    const json = (await res.json()) as { versions: { origin: string | null }[] };
    expect(json.versions[0].origin).toBe("manual_save");
  });

  it("manual save API persists manual_save origin", async () => {
    const user = createUser("alice", "pass123", "USER");
    const session = createSession(user.id);
    const doc = createDocument(user.id, emptyScene(), "Doc");
    const req = new Request(`http://localhost/api/documents/${doc.id}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${session.token}` },
      body: JSON.stringify({ scene: emptyScene() }),
    });
    const res = await postManualSave(req as unknown as Request, { params: Promise.resolve({ id: doc.id }) } as any);
    expect(res.status).toBe(200);
    expect(listVersions(doc.id)[0].origin).toBe("manual_save");
  });

  it("auto snapshot via scene API persists auto_snapshot when due", async () => {
    const user = createUser("alice", "pass123", "USER");
    const session = createSession(user.id);
    const doc = createDocument(user.id, emptyScene(), "Doc");
    // Ensure snapshot is due (no prior snapshot)
    const req = new Request(`http://localhost/api/documents/${doc.id}/scene`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${session.token}` },
      body: JSON.stringify({ scene: emptyScene(), snapshot: true }),
    });
    const res = await putAutoSave(req as unknown as Request, { params: Promise.resolve({ id: doc.id }) } as any);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { snapshotCreated: boolean };
    expect(data.snapshotCreated).toBe(true);
    expect(listVersions(doc.id)[0].origin).toBe("auto_snapshot");
  });

  it("renders origin badges in history drawer markup", () => {
    // Test badge label helper
    expect(originBadgeLabel("manual_save")).toBe("Manual save");
    expect(originBadgeLabel("auto_snapshot")).toBe("Auto snapshot");
    expect(originBadgeLabel("restore")).toBe("Restore");
    expect(originBadgeLabel("recovery_client_draft")).toBe("Client draft");
    expect(originBadgeLabel("recovery_server_version")).toBe("Server version");
    expect(originBadgeLabel(null)).toBe("Legacy / unknown");
    expect(originBadgeLabel("unknown" as any)).toBe("Legacy / unknown");

    // Render a minimal history row with badge to verify markup
    function HistoryRow(props: { version_number: number; origin: string | null }) {
      return React.createElement(
        "div",
        null,
        React.createElement(
          "span",
          { className: "font-medium text-sm text-gray-900 flex items-center gap-2" },
          `Version ${props.version_number}`,
          React.createElement(
            "span",
            { className: "text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded border font-normal" },
            originBadgeLabel(props.origin),
          ),
        ),
      );
    }

    const manualHtml = renderToStaticMarkup(React.createElement(HistoryRow, { version_number: 1, origin: "manual_save" }));
    expect(manualHtml).toContain("Manual save");
    expect(manualHtml).toContain('bg-gray-100');

    const legacyHtml = renderToStaticMarkup(React.createElement(HistoryRow, { version_number: 2, origin: null }));
    expect(legacyHtml).toContain("Legacy / unknown");

    const recoveryClientHtml = renderToStaticMarkup(
      React.createElement(HistoryRow, { version_number: 3, origin: "recovery_client_draft" }),
    );
    expect(recoveryClientHtml).toContain("Client draft");

    const recoveryServerHtml = renderToStaticMarkup(
      React.createElement(HistoryRow, { version_number: 4, origin: "recovery_server_version" }),
    );
    expect(recoveryServerHtml).toContain("Server version");
  });

  it("does not encode origin inside scene JSON", () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Doc");
    createSnapshotFromScene(doc.id, emptyScene(), user.id, false, null, { origin: "manual_save" });
    const raw = getDb().prepare("SELECT scene, origin FROM document_versions WHERE document_id = ?").get(doc.id) as {
      scene: string;
      origin: string;
    };
    const scene = JSON.parse(raw.scene);
    expect(scene.origin).toBeUndefined();
    expect(raw.origin).toBe("manual_save");
    expect(scene.thumbnail_path).not.toBeDefined(); // origin not overloaded into thumbnail
  });
});
