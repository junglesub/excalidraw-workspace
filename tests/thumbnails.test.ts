import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resetDb } from "@/lib/db";
import { resetConfig } from "@/lib/config";
import { createUser, createSession } from "@/lib/users";
import {
  renderScenePng,
  saveThumbnail,
  saveThumbnailFromBuffer,
  removeThumbnail,
  decodePngDataURL,
} from "@/lib/thumbnails";
import { GET as getThumbnailRoute } from "@/app/api/thumbnails/[...path]/route";
import { SESSION_COOKIE } from "@/lib/http";
import { emptyScene } from "@/lib/types";

describe("Thumbnail Rendering and Storage", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("should render a valid PNG buffer with PNG signature", () => {
    const scene = {
      ...emptyScene(),
      elements: [{ id: "elem-1", type: "rectangle" }],
    };
    const pngBuffer = renderScenePng(scene, 100, 100);

    // PNG signature: [137, 80, 78, 71, 13, 10, 26, 10]
    expect(pngBuffer[0]).toBe(0x89);
    expect(pngBuffer[1]).toBe(0x50); // P
    expect(pngBuffer[2]).toBe(0x4e); // N
    expect(pngBuffer[3]).toBe(0x47); // G
    expect(pngBuffer.length).toBeGreaterThan(50);
  });

  it("should save and remove thumbnail files cleanly with forward slashes in relativePath", () => {
    const scene = emptyScene();
    const result = saveThumbnail("doc-123", scene);

    expect(result.relativePath).toBe("thumbnails/doc-123.png");
    expect(existsSync(result.absolutePath)).toBe(true);

    const fileBytes = readFileSync(result.absolutePath);
    expect(fileBytes.length).toBeGreaterThan(0);

    removeThumbnail(result.relativePath);
    expect(existsSync(result.absolutePath)).toBe(false);
  });

  it("should save real thumbnail buffer from client", () => {
    const rawPng = renderScenePng(emptyScene(), 50, 50);
    const result = saveThumbnailFromBuffer("client-real-thumb", rawPng);

    expect(result.relativePath).toBe("thumbnails/client-real-thumb.png");
    expect(existsSync(result.absolutePath)).toBe(true);

    removeThumbnail(result.relativePath);
  });

  it("should decode a valid PNG data URL and reject invalid payloads", () => {
    const rawPng = renderScenePng(emptyScene(), 40, 40);
    const dataURL = `data:image/png;base64,${rawPng.toString("base64")}`;
    const decoded = decodePngDataURL(dataURL);
    expect(decoded).not.toBeNull();
    expect(decoded?.equals(rawPng)).toBe(true);

    expect(decodePngDataURL("data:image/png;base64,AAAA")).toBeNull();
    expect(decodePngDataURL("not-a-data-url")).toBeNull();
    expect(decodePngDataURL(undefined)).toBeNull();
  });

  it("should fall back to a placeholder PNG when the client buffer is not a PNG", () => {
    const result = saveThumbnailFromBuffer("bad-thumb", Buffer.from("not-a-png"));
    expect(existsSync(result.absolutePath)).toBe(true);
    const saved = readFileSync(result.absolutePath);
    expect(saved[0]).toBe(0x89);
    expect(saved[1]).toBe(0x50);
    removeThumbnail(result.relativePath);
  });

  it("should reject path traversal in GET /api/thumbnails/[...path]", async () => {
    const user = createUser("alice", "pass123", "USER");
    const session = createSession(user.id);

    const req = new Request("http://localhost/api/thumbnails/../app.db", {
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
    });
    const res = await getThumbnailRoute(req, { params: Promise.resolve({ path: ["..", "app.db"] }) });
    expect(res.status).toBe(403);
  });
});
