/* ---------------------------------------------------------------------------
 * password.ts — application password hashing (Argon2id) + typable generator.
 *
 * App logins use Argon2id here; Guacamole's own JDBC users deliberately use
 * SHA-256 instead (see sha256SaltedHashPassword) for Guacamole compat — do
 * not "unify" them or every Guacamole login breaks. Generator output is for
 * ONLINE-only guest credentials (rate-limited + lockout), never for keys.
 * ------------------------------------------------------------------------- */
import argon2 from "argon2";
import { randomInt } from "node:crypto";

// --- Argon2id hashing ------------------------------------------------------
// WHY these costs: ~19 MiB / 2 passes / 1 lane is OWASP's baseline for
// interactive logins — slow enough to blunt GPU cracking, light enough that
// a login burst won't OOM the API container.
const HASH_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export const MAX_PASSWORD_LENGTH = 128;
export const MAX_PASSWORD_VERIFY_LENGTH = 512;

/**
 * Hash a new password. Rejects over-long input so Argon2 never burns CPU on
 * a DoS-sized preimage before the route-level validation runs.
 */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error("Password exceeds maximum length");
  }
  return argon2.hash(password, HASH_OPTIONS);
}

/**
 * Verify a login attempt. Never throws: malformed hashes and over-long input
 * both mean "no" (false), so a corrupt row can't turn logins into HTTP 500s
 * or become a user-enumeration oracle via error shape.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (typeof password !== "string" || password.length > MAX_PASSWORD_VERIFY_LENGTH) {
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// --- Typable passphrase generator ------------------------------------------
// Short common words for typable passphrases. Lowercase alpha only, so the
// generator can control casing itself; none contain shell- or chpasswd-
// significant characters.
const PASSPHRASE_WORDS = [
  "acorn", "amber", "apron", "ash", "aspen", "autumn", "baker", "bamboo", "basin", "beacon",
  "birch", "blade", "bloom", "bridge", "brook", "brush", "bunker", "cabin", "cactus", "camel",
  "canyon", "carpet", "cedar", "cherry", "cinder", "citrus", "cliff", "clover", "cobalt", "comet",
  "copper", "coral", "cove", "crane", "creek", "cricket", "daisy", "delta", "denim", "dome",
  "dove", "drift", "drum", "dune", "eagle", "ember", "engine", "falcon", "fern", "flint",
  "forest", "forge", "frost", "garlic", "glacier", "glove", "grove", "harbor", "hazel", "heron",
  "honey", "horizon", "iguana", "indigo", "inlet", "iris", "ivory", "jacket", "jaguar", "jasper",
  "jungle", "karma", "kayak", "kettle", "koala", "ladder", "lagoon", "lantern", "lark", "lava",
  "lemon", "lilac", "linen", "lotus", "lunar", "magnet", "mango", "maple", "marble", "meadow",
  "melon", "mercury", "miller", "mint", "mist", "monarch", "moss", "mountain", "nectar", "needle",
  "nickel", "north", "nugget", "oasis", "ocean", "olive", "onyx", "orchard", "otter", "oxygen",
  "paddle", "panda", "paper", "pebble", "pepper", "petal", "piano", "pilot", "pine", "pioneer",
  "plaza", "poplar", "porch", "prairie", "pumpkin", "quartz", "quilt", "raven", "reef", "ridge",
  "river", "rocket", "rose", "saddle", "sage", "salmon", "sand", "sapphire", "sedona", "shadow",
  "sierra", "silver", "slate", "solar", "spark", "spruce", "stone", "storm", "summit", "sunny",
  "sunset", "tango", "tiger", "timber", "topaz", "trail", "tulip", "tundra", "turbo", "twilight",
  "umbrella", "union", "valley", "velvet", "venus", "violet", "viper", "walnut", "willow", "window",
  "winter", "yellow", "yoga", "zebra", "zephyr",
];

export interface GeneratedPassword {
  password: string;
}

/**
 * Two-word typable passwords with a numeric tail: two capitalized words plus
 * two digits, e.g. "Cabin-Apron-42". Short and memorable on purpose — these
 * are guest and throwaway credentials, always vault-stored, never typed
 * except from the vault reveal/copy UI.
 *
 * The numeric tail is not decoration: generated passwords must satisfy the
 * same complexity policy shown to users (12+ chars, upper, lower, number,
 * symbol) so the system never mints credentials its own rules would reject.
 * Short word pairs are re-rolled until the 12-character minimum holds.
 *
 * Entropy note: ~157 words squared times 100 is roughly 21 bits, which
 * would be thin against offline cracking — but these passwords only ever
 * face ONLINE guessing (RDP/SSH behind login rate limiting plus 5-fail
 * account lockout), where millions of combinations are plenty. They never
 * contain chpasswd- or shell-breaking characters (notably no ":").
 */
export function generatePassword(): string {
  const pick = (): string => {
    const word = PASSPHRASE_WORDS[randomInt(PASSPHRASE_WORDS.length)] as string;
    return word.slice(0, 1).toUpperCase() + word.slice(1);
  };
  for (;;) {
    let first = pick();
    let second = pick();
    if (second === first) second = pick();
    const digits = String(randomInt(100)).padStart(2, "0");
    const candidate = `${first}-${second}-${digits}`;
    // Shortest pairs (e.g. Ash-Dune-07 at 11 chars) miss the policy minimum.
    if (candidate.length >= 12) return candidate;
  }
}