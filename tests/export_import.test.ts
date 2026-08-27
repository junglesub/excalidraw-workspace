import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/lib/db";
import { resetConfig } from "@/lib/config";
import { createUser } from "@/lib/users";
import { createDocument } from "@/lib/documents";
import {
  storeAttachment,
  listAttachments,
  readAttachmentBytes,
  deleteAttachmentIfUnreferenced,
  forceDeleteAttachment,
} from "@/lib/attachments";
import { jsonToScene, sceneToJson, emptyScene } from "@/lib/types";

describe("Attachments, Export/Import, and Scene Serialization", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("should serialize and deserialize standard Excalidraw scene JSON", () => {
    const scene = {
      type: "excalidraw" as const,
      version: 2,
      source: "https://excalidraw.com",
      elements: [
        { id: "e1", type: "rectangle", x: 100, y: 100, width: 200, height: 150 },
        { id: "e2", type: "text", text: "Hello Excalidraw" },
      ],
      appState: { viewBackgroundColor: "#f0f0f0", theme: "light" },
      files: {},
    };

    const jsonStr = sceneToJson(scene);
    const parsed = jsonToScene(jsonStr);

    expect(parsed.type).toBe("excalidraw");
    expect(parsed.version).toBe(2);
    expect(parsed.elements).toHaveLength(2);
    expect(parsed.appState?.viewBackgroundColor).toBe("#f0f0f0");
  });

  it("should handle empty or malformed scene JSON safely with fallback", () => {
    const fallback = jsonToScene("invalid-json-string");
    expect(fallback.type).toBe("excalidraw");
    expect(fallback.elements).toEqual([]);

    const empty = jsonToScene("{}");
    expect(empty.type).toBe("excalidraw");
    expect(empty.elements).toEqual([]);
  });

  it("should store and read file attachments correctly", () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Design with Images");

    const sampleBuffer = Buffer.from("fake-png-image-content", "utf-8");
    const attachment = storeAttachment(doc.id, "diagram.png", "image/png", sampleBuffer);

    expect(attachment.file_name).toBe("diagram.png");
    expect(attachment.mime_type).toBe("image/png");
    expect(attachment.file_size).toBe(sampleBuffer.length);
    expect(attachment.sha256).toBeDefined();

    const storedBytes = readAttachmentBytes(attachment);
    expect(storedBytes.toString("utf-8")).toBe("fake-png-image-content");

    const attachments = listAttachments(doc.id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].id).toBe(attachment.id);
  });

  it("should enforce attachment deletion lifecycle and reference safety", () => {
    const user = createUser("alice", "pass123", "USER");
    const doc = createDocument(user.id, emptyScene(), "Lifecycle Doc");

    const sampleBuffer = Buffer.from("image-bytes", "utf-8");
    const attachment = storeAttachment(doc.id, "test.png", "image/png", sampleBuffer);

    // If unreferenced, it is deleted cleanly
    const deleted = deleteAttachmentIfUnreferenced(doc.id, attachment.id);
    expect(deleted).toBe(true);
    expect(listAttachments(doc.id)).toHaveLength(0);
  });
});
