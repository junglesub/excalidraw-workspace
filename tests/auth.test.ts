import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/lib/db";
import { resetConfig } from "@/lib/config";
import {
  bootstrapAdmin,
  createUser,
  getByUsername,
  getById,
  createSession,
  getUserBySessionToken,
  deleteSession,
  deleteSessionsForUser,
  deleteSessionsForUserExcept,
  setPassword,
  setActive,
  toPublicUser,
  listUsers,
} from "@/lib/users";
import { hashPassword, verifyPassword } from "@/lib/passwords";
import { PATCH as patchPasswordRoute } from "@/app/api/auth/password/route";
import { SESSION_COOKIE, buildCookieValue, readJson, HttpError } from "@/lib/http";

describe("Authentication and User Management", () => {
  beforeEach(() => {
    resetConfig();
    resetDb();
  });

  it("should hash and verify passwords correctly", () => {
    const plain = "SuperSecret123!";
    const hash = hashPassword(plain);
    expect(hash).not.toBe(plain);
    expect(verifyPassword(plain, hash)).toBe(true);
    expect(verifyPassword("WrongPassword", hash)).toBe(false);
  });

  it("should bootstrap initial admin from environment variables", () => {
    bootstrapAdmin();
    const admin = getByUsername("test_admin");
    expect(admin).toBeDefined();
    expect(admin?.role).toBe("ADMIN");
    expect(verifyPassword("test_password123!", admin!.password_hash)).toBe(true);

    // Running bootstrap again should not duplicate or overwrite
    bootstrapAdmin();
    const users = listUsers();
    expect(users.filter((u) => u.username === "test_admin")).toHaveLength(1);
  });

  it("should fail closed in production when bootstrap admin credentials are missing or default", () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevUser = process.env.ADMIN_USERNAME;
    const prevPass = process.env.ADMIN_PASSWORD;

    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      delete process.env.ADMIN_USERNAME;
      delete process.env.ADMIN_PASSWORD;
      resetConfig();

      // Missing credentials in production must throw
      expect(() => bootstrapAdmin()).toThrow(/Production bootstrap error/);

      // Insecure default password in production must throw
      process.env.ADMIN_USERNAME = "prod_admin";
      process.env.ADMIN_PASSWORD = "admin1234!";
      resetConfig();
      expect(() => bootstrapAdmin()).toThrow(/insecure default/);

      // Secure strong credentials in production succeed
      process.env.ADMIN_USERNAME = "prod_admin";
      process.env.ADMIN_PASSWORD = "ValidStrongPassword987!";
      resetConfig();
      expect(() => bootstrapAdmin()).not.toThrow();
      expect(getByUsername("prod_admin")).toBeDefined();
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = prevNodeEnv;
      process.env.ADMIN_USERNAME = prevUser;
      process.env.ADMIN_PASSWORD = prevPass;
      resetConfig();
    }
  });

  it("should set Secure on session cookies in production and omit in non-production", () => {
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "development";
      const devCookie = buildCookieValue("tok123");
      expect(devCookie).toContain("HttpOnly");
      expect(devCookie).toContain("SameSite=Lax");
      expect(devCookie).not.toContain("Secure");

      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      const prodCookie = buildCookieValue("tok123");
      expect(prodCookie).toContain("Secure");
      expect(prodCookie).toContain("HttpOnly");
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = prevNodeEnv;
    }
  });

  it("should enforce bounded JSON request size guards", async () => {
    // Normal small request succeeds
    const validReq = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "value" }),
    });
    const parsed = await readJson(validReq, 1024);
    expect(parsed.key).toBe("value");

    // Content-length header exceeding limit throws 413
    const oversizedHeaderReq = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", "content-length": "2000" },
      body: JSON.stringify({ key: "value" }),
    });
    await expect(readJson(oversizedHeaderReq, 1000)).rejects.toThrow(HttpError);
    try {
      await readJson(oversizedHeaderReq, 1000);
    } catch (err: any) {
      expect(err.status).toBe(413);
    }

    // Body payload exceeding limit throws 413
    const largeStr = "A".repeat(2000);
    const oversizedBodyReq = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: largeStr }),
    });
    await expect(readJson(oversizedBodyReq, 1000)).rejects.toThrow(HttpError);
  });

  it("should create user and manage active status", () => {
    const user = createUser("alice", "password123", "USER");
    expect(user.username).toBe("alice");
    expect(user.role).toBe("USER");
    expect(user.is_active).toBe(1);

    setActive(user.id, false);
    const updated = getById(user.id);
    expect(updated?.is_active).toBe(0);

    const publicUser = toPublicUser(updated!);
    expect(publicUser.is_active).toBe(false);
  });

  it("should manage session creation, verification and deletion", () => {
    const user = createUser("bob", "password123", "USER");
    const { token } = createSession(user.id);

    const authedUser = getUserBySessionToken(token);
    expect(authedUser).toBeDefined();
    expect(authedUser?.id).toBe(user.id);

    // Inactive user cannot authenticate with valid session token
    setActive(user.id, false);
    expect(getUserBySessionToken(token)).toBeUndefined();

    // Re-activate and test session deletion
    setActive(user.id, true);
    expect(getUserBySessionToken(token)).toBeDefined();

    deleteSession(token);
    expect(getUserBySessionToken(token)).toBeUndefined();
  });

  it("should update password and allow clearing sessions on change", () => {
    const user = createUser("charlie", "oldpass123", "USER");
    const { token } = createSession(user.id);

    setPassword(user.id, "newpass456");
    const updated = getById(user.id)!;
    expect(verifyPassword("newpass456", updated.password_hash)).toBe(true);
    expect(verifyPassword("oldpass123", updated.password_hash)).toBe(false);

    deleteSessionsForUser(user.id);
    expect(getUserBySessionToken(token)).toBeUndefined();
  });

  it("should revoke other sessions on password change via PATCH /api/auth/password", async () => {
    const user = createUser("david", "pass123", "USER");
    const session1 = createSession(user.id);
    const session2 = createSession(user.id);

    const req = new Request("http://localhost/api/auth/password", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${session1.token}`,
      },
      body: JSON.stringify({ currentPassword: "pass123", newPassword: "newpassword456" }),
    });

    const res = await patchPasswordRoute(req);
    expect(res.status).toBe(200);

    // Current session remains valid, other sessions are revoked
    expect(getUserBySessionToken(session1.token)).toBeDefined();
    expect(getUserBySessionToken(session2.token)).toBeUndefined();
  });
});
