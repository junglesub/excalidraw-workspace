import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import EditLeaseConflictModal from "@/components/EditLeaseConflictModal";

describe("EditLeaseConflictModal", () => {
  it("renders accessible dialog with required choices and no token leakage", () => {
    const html = renderToStaticMarkup(
      React.createElement(EditLeaseConflictModal, {
        holder: { username: "alice", acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() },
        busy: false,
        error: null,
        onReadOnly: () => {},
        onTakeover: () => {},
      }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("already being edited");
    expect(html).toContain("Open read-only");
    expect(html).toContain("Take over editing");
    expect(html).not.toContain("leaseToken");
    expect(html).not.toContain("clientId");
  });

  it("disables controls when busy and shows error alert", () => {
    const html = renderToStaticMarkup(
      React.createElement(EditLeaseConflictModal, {
        holder: { username: "bob", acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() },
        busy: true,
        error: "Network error, try again",
        onReadOnly: () => {},
        onTakeover: () => {},
      }),
    );
    expect(html).toContain('disabled');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Network error");
    expect(html).toContain("Taking over...");
  });
});
