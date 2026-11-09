/** Typed fetch wrapper over the API (docs/design/11 §4). Types and schemas come from @dnp/contract. */
import {
  acceptInviteResponse,
  apiError,
  createInvitesResponse,
  invitePreviewResponse,
  listInvitesResponse,
  meResponse,
  registerResponse,
  renameTeamResponse,
  revokeInviteResponse,
  seasonResponse,
  type AcceptInviteResponse,
  type CreateInvitesResponse,
  type ErrorCode,
  type InvitePreviewResponse,
  type ListInvitesResponse,
  type MeResponse,
  type RegisterResponse,
  type RenameTeamResponse,
  type RevokeInviteResponse,
  type SeasonResponse,
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
  listInvites(seasonId: string): Promise<ListInvitesResponse>;
  createInvites(seasonId: string, count: number): Promise<CreateInvitesResponse>;
  revokeInvite(seasonId: string, token: string): Promise<RevokeInviteResponse>;
  previewInvite(token: string): Promise<InvitePreviewResponse>;
  register(token: string, email: string): Promise<RegisterResponse>;
  acceptInvite(token: string, teamName: string): Promise<AcceptInviteResponse>;
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
    listInvites: (id) => request("GET", `/seasons/${enc(id)}/invites`, listInvitesResponse),
    createInvites: (id, count) =>
      request("POST", `/seasons/${enc(id)}/invites`, createInvitesResponse, { count }),
    revokeInvite: (id, token) =>
      request("DELETE", `/seasons/${enc(id)}/invites/${enc(token)}`, revokeInviteResponse),
    previewInvite: (token) => request("GET", `/invites/${enc(token)}`, invitePreviewResponse),
    register: (token, email) =>
      request("POST", `/invites/${enc(token)}/register`, registerResponse, { email }),
    acceptInvite: (token, teamName) =>
      request("POST", `/invites/${enc(token)}/accept`, acceptInviteResponse, { teamName }),
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
