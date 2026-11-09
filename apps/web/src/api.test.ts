import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApi } from "./api";

afterEach(() => vi.unstubAllGlobals());

function stub(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("api client", () => {
  it("sends the auth headers and validates the response", async () => {
    const fetchMock = stub(200, { user: null, leagues: [] });
    const api = createApi({
      baseUrl: "/api",
      getAuthHeaders: async () => ({ Authorization: "Bearer t" }),
    });
    await expect(api.me()).resolves.toEqual({ user: null, leagues: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me",
      expect.objectContaining({ method: "GET", headers: { Authorization: "Bearer t" } }),
    );
  });

  it("sends JSON bodies", async () => {
    const fetchMock = stub(200, { ok: true });
    const api = createApi({
      baseUrl: "/api",
      getAuthHeaders: async () => ({ "X-Dev-User-Email": "a@local.test" }),
    });
    await api.register("tok", "a@local.test");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/invites/tok/register",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "a@local.test" }),
        headers: { "Content-Type": "application/json", "X-Dev-User-Email": "a@local.test" },
      }),
    );
  });

  it("parses {error:{code,message}} into a typed ApiError", async () => {
    stub(409, { error: { code: "team_name_taken", message: "taken" } });
    const api = createApi({ baseUrl: "/api", getAuthHeaders: async () => ({}) });
    const err = await api.acceptInvite("tok", "X").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "team_name_taken", message: "taken" });
  });

  it("maps network failures and malformed responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("down"))),
    );
    const api = createApi({ baseUrl: "/api", getAuthHeaders: async () => ({}) });
    await expect(api.me()).rejects.toMatchObject({ code: "network_error" });
    stub(200, { nonsense: true });
    await expect(api.me()).rejects.toMatchObject({ code: "internal_error" });
  });
});
