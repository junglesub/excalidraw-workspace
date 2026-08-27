import bcrypt from "bcryptjs";

const SALT_ROUNDS = 10;

/** Hash a plaintext password with bcrypt. Never store plaintext. */
export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, SALT_ROUNDS);
}

/** Verify a plaintext password against a stored bcrypt hash. */
export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}