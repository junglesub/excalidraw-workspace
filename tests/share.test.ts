import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/lib/db";
import { resetConfig } from "@/lib/config";
import { createUser } from "@/lib/users";
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
import { emptyScene } from "@/lib/types";

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
});
