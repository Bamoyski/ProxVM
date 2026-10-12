import { describe, expect, it } from "vitest";
import { validateQueuePayload } from "./services/queue.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("validateQueuePayload", () => {
  it("accepts well-formed payloads", () => {
    expect(validateQueuePayload({ jobDbId: ID, attempt: 0 })).toEqual({ jobDbId: ID, attempt: 0 });
    expect(validateQueuePayload({ jobDbId: ID, attempt: 7 })).toEqual({ jobDbId: ID, attempt: 7 });
  });

  it("rejects malformed payloads", () => {
    expect(validateQueuePayload(null)).toBeNull();
    expect(validateQueuePayload(undefined)).toBeNull();
    expect(validateQueuePayload("x")).toBeNull();
    expect(validateQueuePayload({})).toBeNull();
    expect(validateQueuePayload({ jobDbId: "not-a-uuid", attempt: 0 })).toBeNull();
    expect(validateQueuePayload({ jobDbId: ID })).toBeNull();
    expect(validateQueuePayload({ jobDbId: ID, attempt: -1 })).toBeNull();
    expect(validateQueuePayload({ jobDbId: ID, attempt: 1.5 })).toBeNull();
    expect(validateQueuePayload({ jobDbId: ID, attempt: "0" })).toBeNull();
  });
});
