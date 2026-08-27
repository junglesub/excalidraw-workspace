import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/lib/db";
import { resetConfig } from "@/lib/config";
import { createUser, createSession } from "@/lib/users";
import { createDocument, addMember, removeMember, listMembers, resolvePermission } from "@/lib/documents";
import {
  createOrReplaceShareLink,
  getShareLinkByDocument,
  getActiveShareLink,
  getValidShareLinkByToken,
  requireValidShareToken,
  deactivateShareLink,
  summarizeShareLink,
} from "@/lib/share_links";
import { GET as getMembersRoute } from "@/app/api/documents/[id]/share/members/route";
import { POST as postShareLinkRoute } from "@/app/api/documents/[id]/share/link/route";
import { GET as getShareRoute } from "@/app/api/share/[token]/route";
import { SESSION_COOKIE } from "@/lib/http";
import { emptyScene, type ExcalidrawScene } from "@/lib/types";

describe("Sharing and Share Links", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("should create, list and remove document members", () => {
    const owner = createUser("alice", "pass123", "USER");
    const member = createUser("bob", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Design Spec");

    addMember(doc.id, member.id, "VIEWER");
    expect(resolvePermission(doc.id, member.id, "USER")).toBe("VIEWER");

    const members = listMembers(doc.id);
    expect(members).toHaveLength(1);
    expect(members[0].username).toBe("bob");
    expect(members[0].permission).toBe("VIEWER");

    removeMember(doc.id, member.id);
    expect(resolvePermission(doc.id, member.id, "USER")).toBeUndefined();
    expect(listMembers(doc.id)).toHaveLength(0);
  });

  it("should enforce authorization on GET /api/documents/[id]/share/members", async () => {
    const owner = createUser("alice", "pass123", "USER");
    const outsider = createUser("eve", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Secret Document");

    // Outsider trying to enumerate members must get 403 Forbidden
    const outsiderSession = createSession(outsider.id);
    const req = new Request(`http://localhost/api/documents/${doc.id}/share/members`, {
      headers: { cookie: `${SESSION_COOKIE}=${outsiderSession.token}` },
    });
    const res = await getMembersRoute(req, { params: Promise.resolve({ id: doc.id }) });
    expect(res.status).toBe(403);

    // Owner can successfully list members
    const ownerSession = createSession(owner.id);
    const ownerReq = new Request(`http://localhost/api/documents/${doc.id}/share/members`, {
      headers: { cookie: `${SESSION_COOKIE}=${ownerSession.token}` },
    });
    const ownerRes = await getMembersRoute(ownerReq, { params: Promise.resolve({ id: doc.id }) });
    expect(ownerRes.status).toBe(200);
  });

  it("should reject invalid expiration date on POST /api/documents/[id]/share/link with 400", async () => {
    const owner = createUser("alice", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Link Doc");
    const ownerSession = createSession(owner.id);

    const req = new Request(`http://localhost/api/documents/${doc.id}/share/link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${ownerSession.token}`,
      },
      body: JSON.stringify({ expiresAt: "invalid-date-string" }),
    });
    const res = await postShareLinkRoute(req, { params: Promise.resolve({ id: doc.id }) });
    expect(res.status).toBe(400);
  });

  it("should create active public share link and summarize URL", () => {
    const owner = createUser("alice", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Public Spec");

    const link = createOrReplaceShareLink(doc.id, null, "VIEWER");
    expect(link.token).toBeDefined();
    expect(link.is_active).toBe(1);

    const active = getActiveShareLink(doc.id);
    expect(active?.token).toBe(link.token);

    const summary = summarizeShareLink(link);
    expect(summary.url).toBe(`/share/${link.token}`);
    expect(summary.is_active).toBe(true);

    const resolved = requireValidShareToken(link.token);
    expect(resolved.document_id).toBe(doc.id);
  });

  it("should reject expired or deactivated share links", () => {
    const owner = createUser("alice", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Expiring Link");

    // Past expiration date
    const expiredDate = new Date(Date.now() - 10000).toISOString();
    const expiredLink = createOrReplaceShareLink(doc.id, expiredDate, "VIEWER");

    expect(getActiveShareLink(doc.id)).toBeUndefined();
    expect(getValidShareLinkByToken(expiredLink.token)).toBeUndefined();
    expect(() => requireValidShareToken(expiredLink.token)).toThrowError(/expired/);

    // Active link then deactivated
    const liveLink = createOrReplaceShareLink(doc.id, null, "VIEWER");
    expect(getActiveShareLink(doc.id)).toBeDefined();

    deactivateShareLink(doc.id);
    expect(getActiveShareLink(doc.id)).toBeUndefined();
    expect(getValidShareLinkByToken(liveLink.token)).toBeUndefined();
  });

  it("should rotate tokens when regenerating share link", () => {
    const owner = createUser("alice", "pass123", "USER");
    const doc = createDocument(owner.id, emptyScene(), "Rotating Link");

    const firstLink = createOrReplaceShareLink(doc.id, null, "VIEWER");
    const firstToken = firstLink.token;

    const secondLink = createOrReplaceShareLink(doc.id, null, "VIEWER");
    const secondToken = secondLink.token;

    expect(secondToken).not.toBe(firstToken);
    expect(getValidShareLinkByToken(firstToken)).toBeUndefined();
    expect(getValidShareLinkByToken(secondToken)).toBeDefined();
  });

  it("should return compact scene without dataURL in GET /api/share/[token]", async () => {
    const owner = createUser("alice", "pass123", "USER");
    const fileId = "share_img_1";
    const rawBytes = Buffer.from("share-image-content", "utf-8");
    const dataURL = `data:image/png;base64,${rawBytes.toString("base64")}`;
    const scene: ExcalidrawScene = {
      ...emptyScene(),
      elements: [{ id: "e1", type: "image", fileId, isDeleted: false }],
      files: {
        [fileId]: { id: fileId, mimeType: "image/png", dataURL, created: Date.now() },
      },
    };
    const doc = createDocument(owner.id, scene, "Shared Doc");
    const link = createOrReplaceShareLink(doc.id, null, "VIEWER");

    const req = new Request(`http://localhost/api/share/${link.token}`);
    const res = await getShareRoute(req, { params: Promise.resolve({ token: link.token }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scene.files[fileId]).toBeDefined();
    expect(body.scene.files[fileId].dataURL).toBeUndefined();
  });
});
