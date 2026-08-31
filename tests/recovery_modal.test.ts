import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import RecoveryConflictModal, { canConfirmSelection, confirmRecoveryChoice } from "@/components/RecoveryConflictModal";

describe("RecoveryConflictModal", () => {
  it("renders blocking dialog with selectable cards, no initial selection, and disabled confirm", () => {
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
    expect(html).toContain("Preserve the version not selected as a recovery snapshot");
    expect(html).toContain('checked=""');
    expect(html).not.toContain("Close");
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).toContain("Confirm selection");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Use client draft");
    expect(html).not.toContain("Use server version");
    expect(html).toContain("Elements: 2");
    expect(html).toContain("Images: 1");
    expect(html).toContain("hover:border-gray-300");
    expect(html).toContain("hover:bg-gray-50");
    expect(html).not.toContain("border-blue-600");
    expect(html).not.toContain("✓");
  });

  it("keeps both cards visible while showing retryable error", () => {
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
    expect(html).toContain("Client draft");
    expect(html).toContain("Server version");
    expect(html).toContain("Confirm selection");
    expect(html).toContain('aria-pressed="false"');
  });

  it("disables cards and confirm while busy and preserves error", () => {
    const html = renderToStaticMarkup(
      React.createElement(RecoveryConflictModal, {
        client: { updatedAt: 100, elementCount: 2, imageCount: 1 },
        server: { updatedAt: 200, elementCount: 3, imageCount: 0 },
        preserveDiscarded: true,
        busy: true,
        error: "busy error",
        onPreserveChange: vi.fn(),
        onChoose: vi.fn(),
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("busy error");
    expect(html).toContain("disabled");
    const disabledCount = (html.match(/disabled=""/g) || []).length;
    expect(disabledCount).toBeGreaterThanOrEqual(3);
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('aria-pressed="true"');
  });

  it("pure confirm guard enables only when selected and not busy and invokes onChoose once", () => {
    expect(canConfirmSelection(null, false)).toBe(false);
    expect(canConfirmSelection("client", false)).toBe(true);
    expect(canConfirmSelection("server", false)).toBe(true);
    expect(canConfirmSelection("client", true)).toBe(false);
    expect(canConfirmSelection(null, true)).toBe(false);

    const onChoose = vi.fn();
    expect(confirmRecoveryChoice(null, false, onChoose)).toBe(false);
    expect(onChoose).not.toHaveBeenCalled();

    expect(confirmRecoveryChoice("client", true, onChoose)).toBe(false);
    expect(onChoose).not.toHaveBeenCalled();

    expect(confirmRecoveryChoice("client", false, onChoose)).toBe(true);
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith("client");

    onChoose.mockClear();
    expect(confirmRecoveryChoice("server", false, onChoose)).toBe(true);
    expect(onChoose).toHaveBeenCalledWith("server");
    expect(onChoose).toHaveBeenCalledTimes(1);
  });
});
