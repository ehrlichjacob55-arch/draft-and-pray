import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GameLine, GameLinesResponse, IngestResponse } from "@dnp/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { idleIngest, meMember, renderRoute } from "../test/utils";

const game = (gameId: string, home: string, away: string, hs: number, as: number) => ({
  gameId,
  home,
  away,
  homeScore: hs,
  awayScore: as,
  status: "final" as const,
  kickoff: "2026-01-10T21:30:00.000Z",
});
const rounds = (wcStatus: "final" | "finalized" = "final"): IngestResponse => ({
  ...idleIngest,
  rounds: [
    {
      round: 1,
      code: "WC",
      status: wcStatus,
      overrideCount: 0,
      finalizedAt: null,
      providerChangedAt: null,
      games: [game("g1", "CAR", "LAR", 31, 34), game("g2", "CHI", "GB", 31, 27)],
    },
    {
      round: 2,
      code: "DIV",
      status: "upcoming",
      overrideCount: 0,
      finalizedAt: null,
      providerChangedAt: null,
      games: [{ ...game("g3", "DEN", "BUF", 0, 0), status: "scheduled" as const }],
    },
  ],
});

const line = (over: Partial<GameLine> = {}): GameLine => ({
  playerId: "p1",
  name: "Chuba Hubbard",
  position: "RB",
  nflTeam: "CAR",
  provider: { counts: { rush_yds: 46, rush_td: 2 } },
  overrides: [],
  effective: { counts: { rush_yds: 46, rush_td: 2 } },
  points: 13.6,
  breakdown: [],
  ...over,
});
const lines = (list: GameLine[], roundStatus: GameLinesResponse["game"]["roundStatus"] = "final") =>
  ({
    game: {
      gameId: "g1",
      round: 1,
      roundStatus,
      home: "CAR",
      away: "LAR",
      homeScore: 31,
      awayScore: 34,
      status: "final",
    },
    lines: list,
  }) satisfies GameLinesResponse;

const dst = line({
  playerId: "DST-LAR",
  name: "LAR D/ST",
  position: "DST",
  nflTeam: "LAR",
  provider: { counts: { def_pts_allowed: 31 } },
  effective: { counts: { def_pts_allowed: 31 } },
  points: 0,
});

function setup(
  api: Record<string, unknown> = {},
  opts: { role?: "commissioner" | "manager"; ingest?: IngestResponse } = {},
) {
  const user = userEvent.setup();
  const gameLines = vi.fn(async () => lines([line(), dst]));
  const r = renderRoute("/commissioner/overrides", {
    api: {
      me: async () => meMember(opts.role ?? "commissioner"),
      ingest: async () => opts.ingest ?? rounds(),
      gameLines,
      ...api,
    },
  });
  return { user, gameLines, ...r };
}
afterEach(() => vi.restoreAllMocks());

describe("Stat overrides page", () => {
  it("is for the commissioner only", async () => {
    setup({}, { role: "manager" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only the commissioner can see this page.",
    );
  });

  it("picks a round, then a game, and lists its lines with points and the Edited marker", async () => {
    const edited = line({
      overrides: [
        { statKey: "rush_td", value: 3, reason: "Scorer fix", at: "2026-01-11T00:00:00Z" },
      ],
      effective: { counts: { rush_yds: 46, rush_td: 3 } },
    });
    const { user, gameLines } = setup({ gameLines: vi.fn(async () => lines([edited, dst])) });
    expect(await screen.findByText("Wild Card")).toBeInTheDocument();
    const games = within(screen.getByRole("list", { name: "Games" }));
    expect(games.getByText("LAR 34 @ CAR 31 · Final")).toBeInTheDocument();
    expect(games.getByText("GB 27 @ CHI 31 · Final")).toBeInTheDocument();
    await user.click(games.getByRole("button", { name: "LAR 34 @ CAR 31 · Final" }));
    const rows = within(await screen.findByRole("list", { name: "Player lines" }));
    const hubbard = within(rows.getByTestId("line-p1"));
    expect(hubbard.getByText("Chuba Hubbard")).toBeInTheDocument();
    expect(hubbard.getByText("RB · CAR")).toBeInTheDocument();
    expect(hubbard.getByLabelText("Points")).toHaveTextContent("13.6");
    expect(hubbard.getByText("Edited")).toBeInTheDocument();
    expect(hubbard.getByRole("list", { name: "Chuba Hubbard overrides" })).toHaveTextContent(
      "Rushing TDs 2 → 3 · Scorer fix",
    );
    expect(within(rows.getByTestId("line-DST-LAR")).queryByText("Edited")).not.toBeInTheDocument();
    // another round
    await user.click(screen.getByRole("button", { name: "DIV" }));
    expect(screen.queryByTestId("game-lines")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /BUF @ DEN/ })).toBeInTheDocument();
    expect(gameLines).toBeDefined();
  });

  it("edits a player: shows the keys of the position with the ESPN value, saves with a reason", async () => {
    const after = lines([
      line({
        overrides: [
          { statKey: "rush_td", value: 5, reason: "Scorer fix", at: "2026-01-11T00:00:00Z" },
        ],
        effective: { counts: { rush_yds: 46, rush_td: 5 } },
        points: 31.6,
      }),
      dst,
    ]);
    const setOverride = vi.fn(async () => after);
    const { user } = setup({ setOverride });
    await user.click(await screen.findByRole("button", { name: "LAR 34 @ CAR 31 · Final" }));
    await user.click(await screen.findByRole("button", { name: "Edit Chuba Hubbard" }));
    const editor = within(screen.getByTestId("line-editor"));
    // skill-position keys, with the provider's value
    expect(within(editor.getByTestId("stat-rush_td")).getByText("ESPN 2")).toBeInTheDocument();
    expect(editor.getByTestId("stat-pass_yds")).toBeInTheDocument();
    expect(editor.queryByTestId("stat-fg_made")).not.toBeInTheDocument();
    expect(editor.queryByTestId("stat-def_sack")).not.toBeInTheDocument();
    // a reason and a whole number are required
    await user.click(editor.getByRole("button", { name: "Save rush_td" }));
    expect(editor.getByRole("alert")).toHaveTextContent("Enter a whole number");
    await user.type(editor.getByLabelText("rush_td override"), "5");
    await user.click(editor.getByRole("button", { name: "Save rush_td" }));
    expect(editor.getByRole("alert")).toHaveTextContent("Enter a reason");
    expect(setOverride).not.toHaveBeenCalled();
    await user.type(editor.getByLabelText(/Reason/), "  Scorer fix ");
    await user.click(editor.getByRole("button", { name: "Save rush_td" }));
    expect(setOverride).toHaveBeenCalledWith("s2026", {
      gameId: "g1",
      playerId: "p1",
      statKey: "rush_td",
      value: 5,
      reason: "Scorer fix",
    });
    // the response replaces the lines: the new points, the marker and the override on the key
    const hubbard = within(await screen.findByTestId("line-p1"));
    expect(await hubbard.findByText("Override 5")).toBeInTheDocument();
    expect(hubbard.getByLabelText("Points")).toHaveTextContent("31.6");
    expect(hubbard.getByText("Edited")).toBeInTheDocument();
    expect(hubbard.getByRole("button", { name: "Clear rush_td" })).toBeInTheDocument();
  });

  it("uses the kicker and defense keys for those positions", async () => {
    const kicker = line({ playerId: "k1", name: "Harrison Mevis", position: "K", nflTeam: "LAR" });
    const { user } = setup({ gameLines: vi.fn(async () => lines([kicker, dst])) });
    await user.click(await screen.findByRole("button", { name: "LAR 34 @ CAR 31 · Final" }));
    await user.click(await screen.findByRole("button", { name: "Edit Harrison Mevis" }));
    expect(screen.getByTestId("stat-fg_made")).toBeInTheDocument();
    expect(screen.queryByTestId("stat-rush_td")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit Harrison Mevis" })); // closes it
    await user.click(screen.getByRole("button", { name: "Edit LAR D/ST" }));
    expect(screen.getByTestId("stat-def_pts_allowed")).toBeInTheDocument();
    expect(screen.getByTestId("stat-ret_td")).toBeInTheDocument();
    expect(screen.queryByTestId("stat-fg_made")).not.toBeInTheDocument();
  });

  it("clears an override", async () => {
    const withOverride = lines([
      line({
        overrides: [
          { statKey: "rush_td", value: 5, reason: "Scorer fix", at: "2026-01-11T00:00:00Z" },
        ],
      }),
    ]);
    const clearOverride = vi.fn(async () => lines([line()]));
    const { user } = setup({ gameLines: vi.fn(async () => withOverride), clearOverride });
    await user.click(await screen.findByRole("button", { name: "LAR 34 @ CAR 31 · Final" }));
    await user.click(await screen.findByRole("button", { name: "Edit Chuba Hubbard" }));
    await user.click(screen.getByRole("button", { name: "Clear rush_td" }));
    expect(clearOverride).toHaveBeenCalledWith("s2026", "g1", "p1", "rush_td");
    const hubbard = within(await screen.findByTestId("line-p1"));
    expect(
      within(await hubbard.findByTestId("stat-rush_td")).getByText("No override"),
    ).toBeInTheDocument();
    expect(hubbard.queryByText("Edited")).not.toBeInTheDocument();
    expect(hubbard.queryByRole("button", { name: "Clear rush_td" })).not.toBeInTheDocument();
  });

  it("shows a server refusal next to the editor", async () => {
    const setOverride = vi.fn(async () => {
      throw new ApiError(409, "round_finalized", "x");
    });
    const { user } = setup({ setOverride });
    await user.click(await screen.findByRole("button", { name: "LAR 34 @ CAR 31 · Final" }));
    await user.click(await screen.findByRole("button", { name: "Edit Chuba Hubbard" }));
    const editor = within(screen.getByTestId("line-editor"));
    await user.type(editor.getByLabelText(/Reason/), "fix");
    await user.type(editor.getByLabelText("rush_td override"), "1");
    await user.click(editor.getByRole("button", { name: "Save rush_td" }));
    expect(await editor.findByRole("alert")).toHaveTextContent("Unfreeze the round first");
  });

  it("is read-only for a finalized round, with a note to unfreeze it first", async () => {
    const frozen = lines(
      [
        line({
          overrides: [
            { statKey: "rush_td", value: 5, reason: "Scorer fix", at: "2026-01-11T00:00:00Z" },
          ],
        }),
      ],
      "finalized",
    );
    const { user } = setup(
      { gameLines: vi.fn(async () => frozen) },
      { ingest: rounds("finalized") },
    );
    await user.click(await screen.findByRole("button", { name: "LAR 34 @ CAR 31 · Final" }));
    expect(await screen.findByText(/This round is finalized/)).toBeInTheDocument();
    const hubbard = within(await screen.findByTestId("line-p1"));
    expect(hubbard.queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument();
    expect(hubbard.getByText("Edited")).toBeInTheDocument();
    expect(hubbard.getByRole("list", { name: "Chuba Hubbard overrides" })).toHaveTextContent(
      "Rushing TDs 2 → 5",
    );
    expect(screen.queryByRole("button", { name: /Clear/ })).not.toBeInTheDocument();
  });

  it("explains an empty season and a line that could not be scored", async () => {
    const { user } = setup(
      {
        gameLines: vi.fn(async () => lines([line({ issue: "Invalid stat line: x" })])),
      },
      {},
    );
    await user.click(await screen.findByRole("button", { name: "LAR 34 @ CAR 31 · Final" }));
    expect(await screen.findByText("Invalid stat line: x")).toBeInTheDocument();
  });

  it("says when there are no games yet", async () => {
    setup({}, { ingest: idleIngest });
    expect(await screen.findByText(/No games yet/)).toBeInTheDocument();
  });
});
