import { describe, it, expect } from "vitest";
import {
  hasUnreadThreat,
  notificationKindLabel,
  notificationTone,
  visibleNotifications,
  type NotificationLike,
} from "./notify.js";

const T0 = Date.parse("2026-10-29T12:00:00.000Z");

function note(over: Partial<NotificationLike> & { id: string; kind: string }): NotificationLike {
  return {
    title: `title ${over.id}`,
    body: null,
    link: null,
    readAt: null,
    createdAt: new Date(T0).toISOString(),
    ...over,
  };
}

describe("notificationTone", () => {
  it("treats a threat as an error and support/backup as warnings", () => {
    expect(notificationTone("threat")).toBe("err");
    expect(notificationTone("ticket")).toBe("warn");
    expect(notificationTone("backup")).toBe("warn");
    expect(notificationTone("registration")).toBe("info");
    expect(notificationTone("user")).toBe("info");
    expect(notificationTone("system")).toBe("neutral");
    // A future kind must not render as an unstyled row.
    expect(notificationTone("something-new")).toBe("neutral");
  });

  it("gives every kind a human label", () => {
    expect(notificationKindLabel("ticket")).toBe("Support");
    expect(notificationKindLabel("registration")).toBe("Registration");
    expect(notificationKindLabel("mystery")).toBe("Mystery");
    expect(notificationKindLabel("")).toBe("Notice");
  });
});

describe("visibleNotifications", () => {
  const rows = [
    note({ id: "old", kind: "system", createdAt: new Date(T0 - 90_000).toISOString(), readAt: new Date(T0).toISOString() }),
    note({ id: "new", kind: "threat", createdAt: new Date(T0).toISOString() }),
    note({ id: "mid", kind: "ticket", createdAt: new Date(T0 - 30_000).toISOString() }),
  ];

  it("shows newest first, read and unread alike", () => {
    expect(visibleNotifications(rows).map((n) => n.id)).toEqual(["new", "mid", "old"]);
  });

  it("filters to unread without dropping the newest-first order", () => {
    expect(visibleNotifications(rows, { unreadOnly: true }).map((n) => n.id)).toEqual(["new", "mid"]);
  });

  it("caps the list so a burst cannot bury the controls", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      note({ id: `n${i}`, kind: "system", createdAt: new Date(T0 - i * 1000).toISOString() }),
    );
    expect(visibleNotifications(many)).toHaveLength(12);
    expect(visibleNotifications(many, { limit: 3 })).toHaveLength(3);
  });

  it("does not mutate the server payload", () => {
    const input = rows.slice();
    visibleNotifications(input);
    expect(input.map((n) => n.id)).toEqual(["old", "new", "mid"]);
  });
});

describe("hasUnreadThreat", () => {
  it("is true only for an unread threat row", () => {
    expect(hasUnreadThreat([note({ id: "a", kind: "threat" })])).toBe(true);
    expect(
      hasUnreadThreat([note({ id: "a", kind: "threat", readAt: new Date(T0).toISOString() })]),
    ).toBe(false);
    expect(hasUnreadThreat([note({ id: "a", kind: "ticket" })])).toBe(false);
    expect(hasUnreadThreat([])).toBe(false);
  });
});
