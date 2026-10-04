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
 * Two-word typable passwords: two capitalized words joined with a hyphen,
 * e.g. "Cabin-Apron". Short and memorable on purpose — these are guest and
 * throwaway credentials, always vault-stored, never typed except from the
 * vault reveal/copy UI.
 *
 * Entropy note: ~157 words squared is roughly 14.6 bits, which would be thin
 * against offline cracking — but these passwords only ever face ONLINE
 * guessing (RDP/SSH behind login rate limiting plus 5-fail account lockout),
 * where tens of thousands of combinations are plenty. They never contain
 * chpasswd- or shell-breaking characters (notably no ":").
 */
export function generatePassword(): string {
  const pick = (): string => {
    const word = PASSPHRASE_WORDS[randomInt(PASSPHRASE_WORDS.length)] as string;
    return word.slice(0, 1).toUpperCase() + word.slice(1);
  };
  let first = pick();
  let second = pick();
  if (second === first) second = pick();
  return `${first}-${second}`;
}