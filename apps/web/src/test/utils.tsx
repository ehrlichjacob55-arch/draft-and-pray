import { act, render } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { vi } from "vitest";
import { ApiContext, type Api } from "../api";
import { AuthContext, type AuthContextValue } from "../auth";
import { ConfigContext, type AppConfig } from "../config";
import { routes } from "../routes";

export const baseConfig: AppConfig = {
  apiBaseUrl: "/api",
  wsUrl: "ws://localhost:3002",
  cognitoUserPoolId: "pool",
  cognitoClientId: "client",
  region: "us-east-1",
  env: "dev",
};

export function fakeAuth(over: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    mode: "cognito",
    status: "signedIn",
    email: "me@example.com",
    getIdToken: async () => "token",
    signOut: vi.fn(async () => {}),
    startSignIn: vi.fn(async () => "code" as const),
    confirmCode: vi.fn(async () => {}),
    resendCode: vi.fn(async () => {}),
    welcomeSignIn: vi.fn(async () => {}),
    devSignIn: vi.fn(),
    ...over,
  };
}

export function fakeApi(over: Partial<Api> = {}): Api {
  const unexpected = (name: string) => () => Promise.reject(new Error(`unexpected api.${name}`));
  return {
    me: unexpected("me"),
    season: unexpected("season"),
    listManagers: unexpected("listManagers"),
    addManager: unexpected("addManager"),
    resendManager: unexpected("resendManager"),
    updateManager: unexpected("updateManager"),
    removeManager: unexpected("removeManager"),
    renameTeam: unexpected("renameTeam"),
    ...over,
  } as Api;
}

export const meMember = (
  role: "commissioner" | "manager" = "manager",
  justClaimed: { seasonId: string; teamId: string; teamName: string }[] = [],
) => ({
  user: { userId: "u1", email: "me@example.com", displayName: "me" },
  leagues: [
    {
      leagueId: "l1",
      name: "Local League",
      role,
      seasons: [
        { seasonId: "s2025", year: 2025, status: "complete" as const },
        { seasonId: "s2026", year: 2026, status: "setup" as const },
      ],
    },
  ],
  justClaimed,
});

export const seasonData = (over: Record<string, unknown> = {}) => ({
  season: {
    seasonId: "s2026",
    leagueId: "l1",
    leagueName: "Local League",
    year: 2026,
    status: "setup" as const,
  },
  teams: [
    { teamId: "t1", name: "Gridiron Gang", isMine: true },
    { teamId: "t2", name: "Pray Hard", isMine: false },
  ],
  myTeamId: "t1" as string | null,
  myRole: "manager" as const,
  maxTeams: 9 as const,
  ...over,
});

export interface RouteOpts {
  auth?: Partial<AuthContextValue>;
  api?: Partial<Api>;
  config?: Partial<AppConfig>;
}

export function renderRoute(path: string, opts: RouteOpts = {}) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const auth = fakeAuth(opts.auth);
  const api = fakeApi(opts.api);
  const utils = render(
    <ConfigContext.Provider value={{ ...baseConfig, ...opts.config }}>
      <AuthHarness initial={auth}>
        <ApiContext.Provider value={api}>
          <RouterProvider router={router} />
        </ApiContext.Provider>
      </AuthHarness>
    </ConfigContext.Provider>,
  );
  /** Simulates the auth state changing (e.g. sign-in completing). */
  const setAuth = (next: Partial<AuthContextValue>) =>
    act(() => harnessSetAuth({ ...auth, ...next }));
  return { router, auth, api, setAuth, ...utils };
}

let harnessSetAuth: (v: AuthContextValue) => void = () => {};

function AuthHarness({ initial, children }: { initial: AuthContextValue; children: ReactNode }) {
  const [auth, setAuth] = useState(initial);
  useEffect(() => {
    harnessSetAuth = setAuth;
  }, []);
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}
