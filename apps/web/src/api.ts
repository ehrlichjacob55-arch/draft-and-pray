/** Typed fetch wrapper over the API (docs/design/11 §4). Types and schemas come from @dnp/contract. */
import {
  addManagerResponse,
  apiError,
  listManagersResponse,
  meResponse,
  removeManagerResponse,
  renameTeamResponse,
  resendManagerResponse,
  seasonResponse,
  updateManagerResponse,
  type AddManagerRequest,
  type AddManagerResponse,
  type ErrorCode,
  type ListManagersResponse,
  type MeResponse,
  type RemoveManagerResponse,
  type RenameTeamResponse,
  type ResendManagerResponse,
  type SeasonResponse,
  type UpdateManagerRequest,
  type UpdateManagerResponse,
} from "@dnp/contract";
import { createContext, useContext } from "react";

interface Schema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | "network_error";
  constructor(status: number, code: ErrorCode | "network_error", message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface Api {
  me(): Promise<MeResponse>;
  season(seasonId: string): Promise<SeasonResponse>;
  listManagers(seasonId: string): Promise<ListManagersResponse>;
  addManager(seasonId: string, body: AddManagerRequest): Promise<AddManagerResponse>;
  resendManager(seasonId: string, teamId: string): Promise<ResendManagerResponse>;
  updateManager(
    seasonId: string,
    teamId: string,
    body: UpdateManagerRequest,
  ): Promise<UpdateManagerResponse>;
  removeManager(seasonId: string, teamId: string): Promise<RemoveManagerResponse>;
  renameTeam(seasonId: string, teamId: string, name: string): Promise<RenameTeamResponse>;
}

export interface ApiOptions {
  baseUrl: string;
  /** Returns the auth headers for the current session (empty when signed out). */
  getAuthHeaders: () => Promise<Record<string, string>>;
}

export function createApi({ baseUrl, getAuthHeaders }: ApiOptions): Api {
  async function request<T>(
    method: string,
    path: string,
    schema: Schema<T>,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(await getAuthHeaders()),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "network_error", "Could not reach the server");
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const parsed = apiError.safeParse(json);
      if (parsed.success)
        throw new ApiError(res.status, parsed.data.error.code, parsed.data.error.message);
      throw new ApiError(res.status, "internal_error", `Request failed (${res.status})`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new ApiError(res.status, "internal_error", "Unexpected response from the server");
    return parsed.data;
  }

  const enc = encodeURIComponent;
  return {
    me: () => request("GET", "/me", meResponse),
    season: (id) => request("GET", `/seasons/${enc(id)}`, seasonResponse),
    listManagers: (id) => request("GET", `/seasons/${enc(id)}/managers`, listManagersResponse),
    addManager: (id, body) =>
      request("POST", `/seasons/${enc(id)}/managers`, addManagerResponse, body),
    resendManager: (id, teamId) =>
      request(
        "POST",
        `/seasons/${enc(id)}/managers/${enc(teamId)}/resend`,
        resendManagerResponse,
        {},
      ),
    updateManager: (id, teamId, body) =>
      request("PATCH", `/seasons/${enc(id)}/managers/${enc(teamId)}`, updateManagerResponse, body),
    removeManager: (id, teamId) =>
      request("DELETE", `/seasons/${enc(id)}/managers/${enc(teamId)}`, removeManagerResponse),
    renameTeam: (seasonId, teamId, name) =>
      request("PATCH", `/teams/${enc(seasonId)}/${enc(teamId)}`, renameTeamResponse, { name }),
  };
}

export const ApiContext = createContext<Api | null>(null);

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used within an ApiContext provider");
  return api;
}
