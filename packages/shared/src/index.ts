// ---------------------------------------------------------------------------
// Shared package barrel: re-exports enums, zod schemas, and domain types.
// WHY barrel-only (no logic): @proxvm/api and @proxvm/core must share one
//   validation/type vocabulary, so imports stay "@proxvm/shared" and drift
//   between duplicated definitions is impossible.
// ---------------------------------------------------------------------------
export * from "./enums.js";
export * from "./schemas.js";
export * from "./types.js";