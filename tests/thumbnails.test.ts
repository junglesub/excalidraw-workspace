import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resetDb } from "@/lib/db";
import { resetConfig } from "@/lib/config";
import {
  renderScenePng,
  saveThumbnail,
  saveThumbnailFromBuffer,
  removeThumbnail,
} from "@/lib/thumbnails";
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
});
