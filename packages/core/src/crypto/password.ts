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
 * Typable passphrase passwords: capitalized words joined with hyphens plus a
 * two-digit number and "!", e.g. "Cabin-Apron-Forge-42!". Always satisfies
 * the account complexity policy (upper, lower, digit, symbol, 12+ chars).
 *
 * The result is AT LEAST `length` characters (exact lengths are not
 * achievable with whole words). Entropy per character is lower than the old
 * random soup, but vault-stored guest passwords are threatened by online
 * guessing, not offline cracking — and these never contain chpasswd- or
 * shell-breaking characters (notably no ":"), which the old alphabet could.
 */
export function generatePassword(length = 24): string {
  const words: string[] = [];
  const target = Math.max(length, 12);
  let text = "";
  while (text.length < target) {
    const word = PASSPHRASE_WORDS[randomInt(PASSPHRASE_WORDS.length)] as string;
    words.push(word);
    text = [
      ...words.map((w) => w.slice(0, 1).toUpperCase() + w.slice(1)),
      String(randomInt(90) + 10),
    ].join("-") + "!";
  }
  return text;
}