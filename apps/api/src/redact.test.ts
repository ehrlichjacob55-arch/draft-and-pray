import { afterEach, describe, expect, it, vi } from "vitest";
import { errorSummary, logError, redact, scrubText } from "./redact";

describe("redact", () => {
  it("replaces sensitive keys deeply (any case) and scrubs emails in strings", () => {
    const out = redact({
      email: "a@example.com",
      nested: { FirstName: "Alex", list: [{ lastName: "Example" }, "mail a@example.com now"] },
      ok: 1,
      testTemporaryPassword: "secret",
    });
    expect(out).toEqual({
      email: "[redacted]",
      nested: { FirstName: "[redacted]", list: [{ lastName: "[redacted]" }, "mail [email] now"] },
      ok: 1,
      testTemporaryPassword: "[redacted]",
    });
  });
  it("scrubs emails and summarizes errors without raw messages", () => {
    expect(scrubText("User a.b+c@example.com exists")).toBe("User [email] exists");
    const e = Object.assign(new Error("bad a@example.com"), { $metadata: { httpStatusCode: 400 } });
    expect(errorSummary(e)).toMatchObject({ name: "Error", message: "bad [email]", status: 400 });
  });
});

describe("logError", () => {
  afterEach(() => vi.restoreAllMocks());
  it("never prints the email in the error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("oops", new Error("failed for a@example.com"), { email: "a@example.com" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("a@example.com");
  });
});
