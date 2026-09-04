import { beforeEach, describe, expect, it } from "vitest";
import { resetConfig } from "@/lib/config";
import { resetDb } from "@/lib/db";
import { createSession, createUser } from "@/lib/users";
import {
  DEFAULT_PRESENTATION_LASER_SETTINGS,
  getPresentationLaserSettings,
  normalizePresentationLaserSettings,
  setPresentationLaserSettings,
} from "@/lib/presentation_laser_settings";
import { GET, PATCH } from "@/app/api/preferences/presentation-laser/route";
import { SESSION_COOKIE } from "@/lib/http";

describe("presentation laser settings", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("provides bounded defaults and normalizes unsafe values", () => {
    expect(DEFAULT_PRESENTATION_LASER_SETTINGS.mode).toBe("trail");
    expect(DEFAULT_PRESENTATION_LASER_SETTINGS.trail.decayMs).toBe(1000);
    expect(DEFAULT_PRESENTATION_LASER_SETTINGS.trail.length).toBe(50);
    const normalized = normalizePresentationLaserSettings({
      mode: "dot",
      trail: { color: "nope", coreSize: 999, glowSize: -1, length: 9999, decayMs: 1 },
      dot: { color: "#123456", size: 1, glowSize: 999 },
    });
    expect(normalized.mode).toBe("dot");
    expect(normalized.trail.color).toBe(DEFAULT_PRESENTATION_LASER_SETTINGS.trail.color);
    expect(normalized.trail.coreSize).toBeLessThanOrEqual(32);
    expect(normalized.trail.glowSize).toBeGreaterThanOrEqual(0);
    expect(normalized.trail.length).toBeLessThanOrEqual(200);
    expect(normalized.trail.decayMs).toBeGreaterThanOrEqual(100);
    expect(normalized.dot.color).toBe("#123456");
  });

  it("persists settings globally per user", () => {
    const a = createUser("laser-a", "password123");
    const b = createUser("laser-b", "password123");
    setPresentationLaserSettings(a.id, { mode: "dot", dot: { size: 16 } });
    expect(getPresentationLaserSettings(a.id).mode).toBe("dot");
    expect(getPresentationLaserSettings(a.id).dot.size).toBe(16);
    expect(getPresentationLaserSettings(b.id)).toEqual(DEFAULT_PRESENTATION_LASER_SETTINGS);
  });

  it("GET/PATCH only read and update the authenticated user's global settings", async () => {
    const user = createUser("laser-route", "password123");
    const { token } = createSession(user.id);
    const headers = { cookie: `${SESSION_COOKIE}=${token}`, "content-type": "application/json" };
    const patch = await PATCH(new Request("http://localhost/api/preferences/presentation-laser", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ mode: "dot", trail: { decayMs: 1750 } }),
    }));
    expect(patch.status).toBe(200);
    const patched = await patch.json();
    expect(patched.settings.mode).toBe("dot");
    expect(patched.settings.trail.decayMs).toBe(1750);

    const get = await GET(new Request("http://localhost/api/preferences/presentation-laser", { headers }));
    expect(get.status).toBe(200);
    expect((await get.json()).settings.mode).toBe("dot");
  });
});
