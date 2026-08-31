import { beforeEach, describe, expect, it } from "vitest";
import { POST as postRecoveryRoute } from "@/app/api/documents/[id]/recovery/route";
import { resetConfig } from "@/lib/config";
import { resetDb, getDb } from "@/lib/db";
import { addMember, createDocument, getDocumentRaw } from "@/lib/documents";
import { SESSION_COOKIE } from "@/lib/http";
import { emptyScene, jsonToScene, sceneToJson } from "@/lib/types";
import { createSession, createUser } from "@/lib/users";
import { listVersions } from "@/lib/versions";

describe("Recovery conflict API", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  function request(docId: string, token: string, body: unknown) {
    return new Request(`http://localhost/api/documents/${docId}/recovery`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  it("selects the client scene and reports the preserved snapshot", async () => {
    const owner = createUser("owner", "pass123", "USER");
    const session = createSession(owner.id);
    const server = { ...emptyScene(), elements: [{ id: "server", type: "rectangle" }] };
    const client = { ...emptyScene(), elements: [{ id: "client", type: "ellipse" }] };
    const doc = createDocument(owner.id, server, "Conflict Doc");

    const response = await postRecoveryRoute(
      request(doc.id, session.token, {
        choice: "client",
        preserveDiscarded: true,
        expectedServerUpdatedAt: doc.updated_at,
        clientScene: client,
        clientUpdatedAt: 123,
      }),
      { params: Promise.resolve({ id: doc.id }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      choice: "client",
      snapshotCreated: true,
    });
    expect(jsonToScene(getDocumentRaw(doc.id)!.scene).elements).toEqual(client.elements);
    expect(listVersions(doc.id)).toHaveLength(1);
  });

  it("rejects a viewer without reading or mutating document recovery state", async () => {
    const owner = createUser("owner", "pass123", "USER");
    const viewer = createUser("viewer", "pass123", "USER");
    const session = createSession(viewer.id);
    const doc = createDocument(owner.id, emptyScene(), "Conflict Doc");
    addMember(doc.id, viewer.id, "VIEWER");

    const response = await postRecoveryRoute(
      request(doc.id, session.token, {
        choice: "server",
        preserveDiscarded: true,
        expectedServerUpdatedAt: doc.updated_at,
        clientScene: emptyScene(),
        clientUpdatedAt: 123,
      }),
      { params: Promise.resolve({ id: doc.id }) },
    );

    expect(response.status).toBe(403);
    expect(listVersions(doc.id)).toHaveLength(0);
  });

  it("returns 400 for an invalid choice or malformed envelope", async () => {
    const owner = createUser("owner", "pass123", "USER");
    const session = createSession(owner.id);
    const doc = createDocument(owner.id, emptyScene(), "Conflict Doc");
    const response = await postRecoveryRoute(
      request(doc.id, session.token, {
        choice: "newest",
        preserveDiscarded: true,
        expectedServerUpdatedAt: doc.updated_at,
        clientScene: emptyScene(),
        clientUpdatedAt: 123,
      }),
      { params: Promise.resolve({ id: doc.id }) },
    );
    expect(response.status).toBe(400);
  });

  it("returns the latest compact server scene on optimistic conflict", async () => {
    const owner = createUser("owner", "pass123", "USER");
    const session = createSession(owner.id);
    const doc = createDocument(owner.id, emptyScene(), "Conflict Doc");
    const latest = { ...emptyScene(), elements: [{ id: "latest", type: "diamond" }] };
    getDb()
      .prepare("UPDATE documents SET scene = ?, updated_at = ? WHERE id = ?")
      .run(sceneToJson(latest), "2099-01-01T00:00:00.000Z", doc.id);

    const response = await postRecoveryRoute(
      request(doc.id, session.token, {
        choice: "client",
        preserveDiscarded: true,
        expectedServerUpdatedAt: doc.updated_at,
        clientScene: { ...emptyScene(), elements: [{ id: "client", type: "ellipse" }] },
        clientUpdatedAt: 123,
      }),
      { params: Promise.resolve({ id: doc.id }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      code: "SERVER_VERSION_CHANGED",
      serverScene: latest,
      serverUpdatedAt: "2099-01-01T00:00:00.000Z",
    });
    expect(listVersions(doc.id)).toHaveLength(0);
  });
});
