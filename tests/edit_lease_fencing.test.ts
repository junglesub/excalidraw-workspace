import { beforeEach, describe, expect, it } from "vitest";
import { resetConfig } from "@/lib/config";
import { resetDb, getDb } from "@/lib/db";
import { addMember, createDocument, getDocumentRaw } from "@/lib/documents";
import { createUser } from "@/lib/users";
import { acquireEditLease, requestEditTakeover, pollEditTakeover, TAKEOVER_TIMEOUT_MS } from "@/lib/edit_lease";
import { handleManualSave, resolveRecoveryConflict, restoreVersion, createSnapshotFromScene, listVersions, handleAutoSave } from "@/lib/versions";
import { emptyScene, jsonToScene, sceneToJson } from "@/lib/types";

describe("Edit lease fencing of mutations", () => {
  const NOW = new Date();

  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  function acquireLease(docId: string, userId: string, clientId = "client-a", leaseToken = "token-a") {
    const res = acquireEditLease({ docId, userId, role: "USER", adminMode: false, clientId, leaseToken }, NOW);
    if (res.state !== "acquired") throw new Error("acquire failed");
    return { clientId, leaseToken, generation: res.generation };
  }

  it("rejects stale auto-save and preserves document and versions", () => {
    const holder = createUser("holder", "pass123", "USER");
    const requester = createUser("requester", "pass123", "USER");
    const doc = createDocument(holder.id, emptyScene(), "Doc");
    addMember(doc.id, requester.id, "EDITOR");

    const lease = acquireLease(doc.id, holder.id, "c-holder", "t-holder");
    const staleLease = { ...lease };

    // Force takeover
    const pending = requestEditTakeover({ docId: doc.id, userId: requester.id, role: "USER", adminMode: false, clientId: "c-req", leaseToken: "t-req" }, NOW);
    if (pending.state !== "takeover_pending") throw new Error("pending");
    const acquired = pollEditTakeover({ docId: doc.id, userId: requester.id, role: "USER", adminMode: false, clientId: "c-req", leaseToken: "t-req", requestId: (pending as any).requestId }, new Date(NOW.getTime() + TAKEOVER_TIMEOUT_MS));
    if (acquired.state !== "acquired") throw new Error("forced");

    const scene = { ...emptyScene(), elements: [{ id: "x", type: "rectangle" }] };
    const beforeScene = getDocumentRaw(doc.id)!.scene;
    const beforeVersions = getDb().prepare("SELECT COUNT(*) as c FROM document_versions").get() as { c: number };

    let threw=false; try { handleAutoSave(doc.id, holder.id, "USER", false, scene, null, false, staleLease); } catch (e:any) { threw=true; expect(e.code).toBe("EDIT_LEASE_LOST"); } expect(threw).toBe(true);

    expect(getDocumentRaw(doc.id)!.scene).toBe(beforeScene);
    const afterVersions = getDb().prepare("SELECT COUNT(*) as c FROM document_versions").get() as { c: number };
    expect(afterVersions.c).toBe(beforeVersions.c);

    // Success with new lease
    const newLease = { clientId: "c-req", leaseToken: "t-req", generation: (acquired as any).generation };
    const res = handleAutoSave(doc.id, requester.id, "USER", false, scene, null, false, newLease);
    expect(res.updatedAt).toBeDefined();
    expect(jsonToScene(getDocumentRaw(doc.id)!.scene).elements).toEqual(scene.elements);
  });

  it("rejects stale manual save", () => {
    const holder = createUser("holder", "pass123", "USER");
    const requester = createUser("requester", "pass123", "USER");
    const doc = createDocument(holder.id, emptyScene(), "Doc");
    addMember(doc.id, requester.id, "EDITOR");

    const lease = acquireLease(doc.id, holder.id, "c-holder", "t-holder");
    const pending = requestEditTakeover({ docId: doc.id, userId: requester.id, role: "USER", adminMode: false, clientId: "c-req", leaseToken: "t-req" }, NOW);
    const acquired = pollEditTakeover({ docId: doc.id, userId: requester.id, role: "USER", adminMode: false, clientId: "c-req", leaseToken: "t-req", requestId: (pending as any).requestId }, new Date(NOW.getTime() + TAKEOVER_TIMEOUT_MS));
    if (acquired.state !== "acquired") throw new Error();

    const scene = { ...emptyScene(), elements: [{ id: "m1", type: "ellipse" }] };
    const beforeScene = getDocumentRaw(doc.id)!.scene;
    let threw=false; try { handleManualSave(doc.id, holder.id, "USER", false, scene, null, lease); } catch (e:any) { threw=true; expect(e.code).toBe("EDIT_LEASE_LOST"); } expect(threw).toBe(true);
    expect(getDocumentRaw(doc.id)!.scene).toBe(beforeScene);
    expect(listVersions(doc.id)).toHaveLength(0);

    const newLease = { clientId: "c-req", leaseToken: "t-req", generation: (acquired as any).generation };
    const res = handleManualSave(doc.id, requester.id, "USER", false, scene, null, newLease);
    expect(res.snapshotCreated).toBe(true);
    expect(listVersions(doc.id)).toHaveLength(1);
  });

  it("rejects stale recovery resolution", () => {
    const holder = createUser("holder", "pass123", "USER");
    const requester = createUser("requester", "pass123", "USER");
    const serverScene = { ...emptyScene(), elements: [{ id: "s", type: "rectangle" }] };
    const doc = createDocument(holder.id, serverScene, "Doc");
    addMember(doc.id, requester.id, "EDITOR");

    const lease = acquireLease(doc.id, holder.id, "c-holder", "t-holder");
    const pending = requestEditTakeover({ docId: doc.id, userId: requester.id, role: "USER", adminMode: false, clientId: "c-req", leaseToken: "t-req" }, NOW);
    const acquired = pollEditTakeover({ docId: doc.id, userId: requester.id, role: "USER", adminMode: false, clientId: "c-req", leaseToken: "t-req", requestId: (pending as any).requestId }, new Date(NOW.getTime() + TAKEOVER_TIMEOUT_MS));
    if (acquired.state !== "acquired") throw new Error();

    const clientScene = { ...emptyScene(), elements: [{ id: "c", type: "ellipse" }] };
    const beforeScene = getDocumentRaw(doc.id)!.scene;
    let threw=false; try { resolveRecoveryConflict(doc.id, holder.id, "USER", false, { choice: "client", preserveDiscarded: false, expectedServerUpdatedAt: doc.updated_at, clientScene, thumbnailBuffer: null }, lease); } catch (e:any) { threw=true; expect(e.code).toBe("EDIT_LEASE_LOST"); } expect(threw).toBe(true);
    expect(getDocumentRaw(doc.id)!.scene).toBe(beforeScene);

    const newLease = { clientId: "c-req", leaseToken: "t-req", generation: (acquired as any).generation };
    const ok = resolveRecoveryConflict(doc.id, requester.id, "USER", false, { choice: "client", preserveDiscarded: false, expectedServerUpdatedAt: getDocumentRaw(doc.id)!.updated_at, clientScene, thumbnailBuffer: null }, newLease);
    expect(ok.ok).toBe(true);
  });

  it("rejects stale history restore", () => {
    const holder = createUser("holder", "pass123", "USER");
    const requester = createUser("requester", "pass123", "USER");
    const doc = createDocument(holder.id, emptyScene(), "Doc");
    addMember(doc.id, requester.id, "EDITOR");
    const v1 = { ...emptyScene(), elements: [{ id: "v1", type: "rectangle" }] };
    const snap = createSnapshotFromScene(doc.id, v1, holder.id, false);
    // ensure current doc is distinct
    const lease = acquireLease(doc.id, holder.id, "c-holder", "t-holder");
    const pending = requestEditTakeover({ docId: doc.id, userId: requester.id, role: "USER", adminMode: false, clientId: "c-req", leaseToken: "t-req" }, NOW);
    const acquired = pollEditTakeover({ docId: doc.id, userId: requester.id, role: "USER", adminMode: false, clientId: "c-req", leaseToken: "t-req", requestId: (pending as any).requestId }, new Date(NOW.getTime() + TAKEOVER_TIMEOUT_MS));
    if (acquired.state !== "acquired") throw new Error();

    const beforeScene = getDocumentRaw(doc.id)!.scene;
    const beforeCount = (getDb().prepare("SELECT COUNT(*) as c FROM document_versions").get() as { c: number }).c;
    let threw=false; try { restoreVersion(doc.id, snap.id, holder.id, "USER", false, lease); } catch (e:any) { threw=true; expect(e.code).toBe("EDIT_LEASE_LOST"); } expect(threw).toBe(true);
    expect(getDocumentRaw(doc.id)!.scene).toBe(beforeScene);
    expect((getDb().prepare("SELECT COUNT(*) as c FROM document_versions").get() as { c: number }).c).toBe(beforeCount);

    const newLease = { clientId: "c-req", leaseToken: "t-req", generation: (acquired as any).generation };
    const res = restoreVersion(doc.id, snap.id, requester.id, "USER", false, newLease);
    expect(res.origin).toBe("restore");
    expect((getDb().prepare("SELECT COUNT(*) as c FROM document_versions").get() as { c: number }).c).toBe(beforeCount + 1);
  });
});
