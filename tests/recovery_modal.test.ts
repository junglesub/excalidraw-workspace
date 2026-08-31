import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import RecoveryConflictModal from "@/components/RecoveryConflictModal";

describe("RecoveryConflictModal", () => {
  it("renders a blocking dialog with both choices and preservation enabled", () => {
    const html = renderToStaticMarkup(
      React.createElement(RecoveryConflictModal, {
        client: { updatedAt: 100, elementCount: 2, imageCount: 1 },
        server: { updatedAt: "2026-08-31T00:00:00.000Z", elementCount: 3, imageCount: 0 },
        preserveDiscarded: true,
        busy: false,
        error: null,
        onPreserveChange: vi.fn(),
        onChoose: vi.fn(),
      }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Client draft");
    expect(html).toContain("Server version");
    expect(html).toContain("Use client draft");
    expect(html).toContain("Use server version");
    expect(html).toContain("Preserve the version not selected as a recovery snapshot");
    expect(html).toContain('checked=""');
    expect(html).not.toContain("Close");
  });

  it("keeps both choices visible while showing a retryable error", () => {
    const html = renderToStaticMarkup(
      React.createElement(RecoveryConflictModal, {
        client: { updatedAt: 100, elementCount: 2, imageCount: 1 },
        server: { updatedAt: 200, elementCount: 3, imageCount: 0 },
        preserveDiscarded: true,
        busy: false,
        error: "snapshot failed",
        onPreserveChange: vi.fn(),
        onChoose: vi.fn(),
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("snapshot failed");
    expect(html).toContain("Use client draft");
    expect(html).toContain("Use server version");
  });
});
