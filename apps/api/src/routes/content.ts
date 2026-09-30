import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoreContext } from "@proxvm/core";
import { AppError } from "@proxvm/core";

// Mini-CMS: editable site copy for text the operator wants to change without
// a code deploy (contact details, donate tiers/intro). Stored as plain
// settings rows — no migration, no new tables.
//
// Safety notes (load-bearing):
// - Keys are an exact allowlist, so nothing else in settings is reachable
//   through here.
// - Values render as TEXT in React (auto-escaped). Link-bearing keys are
//   additionally restricted to https:// (and mailto: for email) server-side,
//   because href attributes are the one place escaping alone is not enough.
// - Reads require a session (matches the visibility of the pages that show
//   the copy); writes require settings.manage. Nothing here is public.

const KNOWN_KEYS = [
  "contact.email",
  "contact.github",
  "contact.repo",
  "donate.intro",
  "donate.funfact",
  "donate.tiers",
];
const MAX_VALUE_LENGTH = 5000;

function assertValidKey(key: string): void {
  if (!KNOWN_KEYS.includes(key)) {
    throw AppError.validation(`Unknown content key "${key}"`);
  }
}

function assertValidEntry(key: string, value: string): void {
  assertValidKey(key);
  if (value.length > MAX_VALUE_LENGTH) {
    throw AppError.validation(`Content for "${key}" must be ${MAX_VALUE_LENGTH} characters or fewer`);
  }
  if (key === "contact.email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw AppError.validation("contact.email must be an email address");
  }
  if ((key === "contact.github" || key === "contact.repo") && !/^https:\/\/\S+$/.test(value)) {
    throw AppError.validation(`${key} must be an https:// URL`);
  }
  if (key === "donate.tiers") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw AppError.validation("donate.tiers must be JSON: an array of {amount, blurb}");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length > 12 ||
      parsed.some(
        (t) =>
          typeof t !== "object" ||
          t === null ||
          typeof (t as { amount?: unknown }).amount !== "string" ||
          typeof (t as { blurb?: unknown }).blurb !== "string" ||
          (t as { amount: string }).amount.length > 24 ||
          (t as { blurb: string }).blurb.length > 300,
      )
    ) {
      throw AppError.validation("donate.tiers must be ≤12 entries of {amount ≤24 chars, blurb ≤300 chars}");
    }
  }
}

export async function contentRoutes(app: FastifyInstance, opts: { ctx: CoreContext }): Promise<void> {
  const ctx = opts.ctx;

  app.get("/content", async (request) => {
    await app.requireAuth(request);
    const placeholders = KNOWN_KEYS.map((_, i) => `$${i + 1}`).join(",");
    const result = await ctx.db.query<{ key: string; value: string }>(
      `SELECT key, value FROM settings WHERE key IN (${placeholders}) AND encrypted = FALSE`,
      KNOWN_KEYS,
    );
    const entries: Record<string, string> = {};
    for (const row of result.rows) entries[row.key] = row.value;
    return { entries };
  });

  app.put("/content", async (request) => {
    const actor = await app.requirePermission("settings.manage")(request);
    const body = z
      .object({
        entries: z.record(z.string(), z.string()).refine((e) => Object.keys(e).length <= 20, {
          message: "At most 20 entries per save",
        }),
      })
      .parse(request.body);
    const keys = Object.keys(body.entries);
    for (const [key, value] of Object.entries(body.entries)) {
      // Key shape is always validated (even on reset); empty values skip
      // value validation because empty means "delete, back to built-in".
      assertValidKey(key);
      if (value !== "") assertValidEntry(key, value);
    }
    for (const [key, value] of Object.entries(body.entries)) {
      if (value === "") {
        // Empty resets to the built-in default (row deleted, fallback wins).
        await ctx.db.query("DELETE FROM settings WHERE key = $1", [key]);
      } else {
        await ctx.settings.set(key, value, { category: "content" });
      }
    }
    await ctx.audit.record({
      event: "SETTINGS_CHANGED",
      actorUserId: actor.id,
      actorUsername: actor.username,
      detail: { section: "content", keys },
    });
    return { ok: true, keys };
  });
}
