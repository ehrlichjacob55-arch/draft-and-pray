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
    const fetchMock = stub(200, { user: null, leagues: [], justClaimed: [] });
    const api = createApi({
      baseUrl: "/api",
      getAuthHeaders: async () => ({ Authorization: "Bearer t" }),
    });
    await expect(api.me()).resolves.toEqual({ user: null, leagues: [], justClaimed: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me",
      expect.objectContaining({ method: "GET", headers: { Authorization: "Bearer t" } }),
    );
  });

  it("sends JSON bodies", async () => {
    const fetchMock = stub(200, { ok: true, teamId: "t1", name: "Team Example", abbr: "EXAM" });
    const api = createApi({
      baseUrl: "/api",
      getAuthHeaders: async () => ({ "X-Dev-User-Email": "a@local.test" }),
    });
    await api.removeManager("s1", "t 1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/seasons/s1/managers/t%201",
      expect.objectContaining({ method: "DELETE" }),
    );
    await api.renameTeam("s1", "t1", "Team Example");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/teams/s1/t1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "Team Example" }),
        headers: { "Content-Type": "application/json", "X-Dev-User-Email": "a@local.test" },
      }),
    );
  });

  it("parses {error:{code,message}} into a typed ApiError", async () => {
    stub(409, { error: { code: "team_name_taken", message: "taken" } });
    const api = createApi({ baseUrl: "/api", getAuthHeaders: async () => ({}) });
    const err = await api.renameTeam("s", "t", "X").catch((e: unknown) => e);
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
