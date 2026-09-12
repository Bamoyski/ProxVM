import argon2 from "argon2";
import { randomInt } from "node:crypto";

const HASH_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, HASH_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

const LOWERCASE = "abcdefghjkmnpqrstuvwxyz";
const UPPERCASE = "ABCDEFGHJKMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SPECIAL = "!@#$%^&*()-_=+[]{};:,.<>?";
const ALL_ALLOWED = LOWERCASE + UPPERCASE + DIGITS + SPECIAL;

export interface GeneratedPassword {
  password: string;
}

export function generatePassword(length = 24): string {
  const chars: string[] = [];
  chars.push(LOWERCASE[randomInt(LOWERCASE.length)] as string);
  chars.push(UPPERCASE[randomInt(UPPERCASE.length)] as string);
  chars.push(DIGITS[randomInt(DIGITS.length)] as string);
  chars.push(SPECIAL[randomInt(SPECIAL.length)] as string);
  for (let i = chars.length; i < length; i++) {
    chars.push(ALL_ALLOWED[randomInt(ALL_ALLOWED.length)] as string);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = chars[i] as string;
    chars[i] = chars[j] as string;
    chars[j] = tmp;
  }
  return chars.join("");
}