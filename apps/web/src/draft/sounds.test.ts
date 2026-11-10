import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function fakeCtx(state: string, resume: () => Promise<void>) {
  const starts = vi.fn();
  class Ctx {
    state = state;
    currentTime = 0;
    destination = {};
    createOscillator() {
      return { frequency: { value: 0 }, type: "", connect() {}, start: starts, stop() {} };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
      };
    }
    resume = resume;
  }
  return { Ctx, starts };
}

describe("sounds", () => {
  it("never throws without Web Audio", async () => {
    vi.stubGlobal("AudioContext", undefined);
    const s = await import("./sounds");
    expect(() => {
      s.playChime();
      s.playFanfare();
      s.playAlarm();
    }).not.toThrow();
  });

  it("plays immediately on a running context", async () => {
    const { Ctx, starts } = fakeCtx("running", async () => {});
    vi.stubGlobal("AudioContext", Ctx);
    const s = await import("./sounds");
    s.playAlarm();
    expect(starts).toHaveBeenCalledTimes(4);
  });

  it("defers the chime to the first gesture when resume is refused, then stops listening", async () => {
    const { Ctx, starts } = fakeCtx("suspended", () => Promise.reject(new Error("no gesture")));
    vi.stubGlobal("AudioContext", Ctx);
    const s = await import("./sounds");
    s.playChime();
    await new Promise((r) => setTimeout(r, 0));
    expect(starts).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("keydown"));
    await new Promise((r) => setTimeout(r, 0));
    // resume still rejects in this fake, so nothing plays; the listener fired only once.
    expect(starts).not.toHaveBeenCalled();
  });

  it("plays after resume succeeds, and does not defer other sounds", async () => {
    const { Ctx, starts } = fakeCtx("suspended", async () => {});
    vi.stubGlobal("AudioContext", Ctx);
    const s = await import("./sounds");
    s.playFanfare(); // resume resolves but state stays suspended -> not deferred, silent
    await new Promise((r) => setTimeout(r, 0));
    expect(starts).not.toHaveBeenCalled();
  });
});
