import type { AvailablePlayer, DraftSnapshot, SlotName } from "@dnp/contract";
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
    draft: unexpected("draft"),
    makePick: unexpected("makePick"),
    saveQueue: unexpected("saveQueue"),
    setAutoDraft: unexpected("setAutoDraft"),
    realtimeTicket: unexpected("realtimeTicket"),
    setDraftOrder: unexpected("setDraftOrder"),
    startDraft: unexpected("startDraft"),
    pauseDraft: unexpected("pauseDraft"),
    resumeDraft: unexpected("resumeDraft"),
    startClock: unexpected("startClock"),
    clearClock: unexpected("clearClock"),
    autopick: unexpected("autopick"),
    undoPick: unexpected("undoPick"),
    listPlayers: unexpected("listPlayers"),
    importPool: unexpected("importPool"),
    setPlayerInPool: unexpected("setPlayerInPool"),
    addPlayer: unexpected("addPlayer"),
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
    { teamId: "t1", name: "Gridiron Gang", abbr: "GRID", isMine: true },
    { teamId: "t2", name: "Pray Hard", abbr: "PRAY", isMine: false },
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

// ---- Draft fixtures ----

export const TEAM_IDS = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"];
export const TEAM_ABBRS = ["GRID", "PRAY", "BLIT", "HAIL", "REDZ", "PUNT", "SACK", "TRIC", "LONG"];
export const TEAM_NAMES = [
  "Gridiron Gang",
  "Pray Hard",
  "Blitz Club",
  "Hail Marys",
  "Red Zone",
  "Punt Squad",
  "Sack Attack",
  "Trick Plays",
  "Long Snappers",
];

export const player = (
  id: string,
  name: string,
  position: AvailablePlayer["position"],
  over: Partial<AvailablePlayer> = {},
): AvailablePlayer => ({
  playerId: id,
  name,
  position,
  nflTeam: "AAA",
  seed: 1,
  injuryStatus: null,
  depthChartOrder: 1,
  rank: null,
  opponent: null,
  ...over,
});

export const defaultPlayers = (): AvailablePlayer[] => [
  player("p1", "Quinn Quarter", "QB"),
  player("p2", "Rory Runner", "RB", { nflTeam: "BBB", seed: 2, injuryStatus: "Q" }),
  player("p3", "Wes Wideout", "WR", { nflTeam: "BBB", seed: 2, opponent: "CCC" }),
  player("p4", "Tim Tightend", "TE", { nflTeam: "CCC", seed: 3 }),
  player("p5", "Kai Kicker", "K", { nflTeam: "CCC", seed: 3 }),
  player("p6", "AAA Defense", "DST"),
  // Enough depth that the dead-end guard (isDraftable) lets an empty roster draft any position.
  player("p7", "Quentin Backup", "QB", { nflTeam: "DDD", seed: 4 }),
  player("p8", "Rex Rusher", "RB", { nflTeam: "DDD", seed: 4 }),
  player("p9", "Ray Rusher", "RB", { nflTeam: "DDD", seed: 4 }),
  player("p10", "Walt Wide", "WR", { nflTeam: "DDD", seed: 4 }),
  player("p11", "Wade Wide", "WR", { nflTeam: "DDD", seed: 4 }),
  player("p12", "Tom Tight", "TE", { nflTeam: "DDD", seed: 4 }),
  player("p13", "Kurt Kick", "K", { nflTeam: "DDD", seed: 4 }),
  player("p14", "DDD Defense", "DST", { nflTeam: "DDD", seed: 4 }),
];

/** A fake-name draft snapshot; override any field. Default: in progress, pick 1, I am t1 (manager). */
export function draftData(over: Partial<DraftSnapshot> = {}): DraftSnapshot {
  const emptyRoster = Object.fromEntries(
    (["QB", "RB1", "RB2", "WR1", "WR2", "TE", "FLEX1", "FLEX2", "DST", "K"] as SlotName[]).map(
      (s) => [s, null],
    ),
  ) as Record<SlotName, string | null>;
  return {
    seasonId: "s2026",
    version: 1,
    status: "in_progress",
    totalPicks: 90,
    currentPick: 1,
    round: 1,
    order: TEAM_IDS.map((teamId, i) => ({
      position: i + 1,
      teamId,
      name: TEAM_NAMES[i]!,
      abbr: TEAM_ABBRS[i]!,
    })),
    teams: TEAM_IDS.map((teamId, i) => ({
      teamId,
      name: TEAM_NAMES[i]!,
      abbr: TEAM_ABBRS[i]!,
      joined: true,
    })),
    onClockTeamId: "t1",
    clock: null,
    serverNow: "2026-01-01T00:00:00.000Z",
    picks: [],
    rosters: Object.fromEntries(TEAM_IDS.map((t) => [t, { ...emptyRoster }])),
    available: defaultPlayers(),
    myTeamId: "t1",
    myRole: "manager",
    myQueue: [],
    myAutoDraft: false,
    autoDraftTeamIds: [],
    startBlockers: [],
    ...over,
  };
}
