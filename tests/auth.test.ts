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
  setPassword,
  setActive,
  toPublicUser,
  listUsers,
} from "@/lib/users";
import { hashPassword, verifyPassword } from "@/lib/passwords";

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
});
