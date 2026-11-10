import { describe, expect, it } from "vitest";
import { clockRemainingMs, formatClock } from "./clock";

describe("clockRemainingMs", () => {
  const expiresAt = "2026-01-01T00:01:30.000Z";
  it("uses the server's now, not the client clock", () => {
    // Server says it is 00:00:00; the client clock is 1 hour ahead but only the elapsed time matters.
    const receivedAt = Date.parse("2026-01-01T01:00:00.000Z");
    expect(clockRemainingMs(expiresAt, "2026-01-01T00:00:00.000Z", receivedAt, receivedAt)).toBe(
      90_000,
    );
    expect(
      clockRemainingMs(expiresAt, "2026-01-01T00:00:00.000Z", receivedAt, receivedAt + 30_000),
    ).toBe(60_000);
  });
  it("goes negative once expired", () => {
    expect(clockRemainingMs(expiresAt, "2026-01-01T00:02:00.000Z", 1000, 1000)).toBe(-30_000);
  });
});

describe("formatClock", () => {
  it("formats m:ss and floors at zero", () => {
    expect(formatClock(90_000)).toBe("1:30");
    expect(formatClock(59_001)).toBe("1:00");
    expect(formatClock(5_000)).toBe("0:05");
    expect(formatClock(-4_000)).toBe("0:00");
  });
});
