import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IngestResponse } from "@dnp/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { draftData, idleIngest, meMember, renderRoute, seasonData } from "../test/utils";

type R = IngestResponse["rounds"][number];
const round = (n: number, code: R["code"], status: R["status"], over: Partial<R> = {}): R => ({
  round: n,
  code,
  status,
  overrideCount: 0,
  finalizedAt: null,
  providerChangedAt: null,
  games: [],
  ...over,
});
const state = (rounds: R[]): IngestResponse => ({ ...idleIngest, rounds });

function setup(initial: IngestResponse, api: Record<string, unknown> = {}) {
  const user = userEvent.setup();
  const ingest = vi.fn(async () => initial);
  const r = renderRoute("/commissioner", {
    api: {
      me: async () => meMember("commissioner"),
      season: async () => seasonData({ myRole: "commissioner" }),
      draft: async () => draftData({ myRole: "commissioner" }),
      listManagers: async () => [],
      scoring: async () => ({ seasonId: "s2026", active: null, versions: [] }),
      ingest,
      ...api,
    },
  });
  return { user, ingest, ...r };
}
const card = async () => within(await screen.findByTestId("rounds-section"));
const row = async (code: string) => within(await (await card()).findByTestId(`round-row-${code}`));

afterEach(() => vi.restoreAllMocks());

describe("Rounds card", () => {
  it("lists each round with its status badge and override count, above the Live stats card", async () => {
    setup(
      state([
        round(1, "WC", "final", { overrideCount: 3 }),
        round(2, "DIV", "live", { overrideCount: 1 }),
        round(3, "CONF", "upcoming"),
        round(4, "SB", "upcoming"),
      ]),
    );
    const wc = await row("WC");
    expect(await wc.findByText("Wild Card")).toBeInTheDocument();
    expect(wc.getByText("Final")).toBeInTheDocument();
    expect(wc.getByText("3 overrides")).toBeInTheDocument();
    const div = await row("DIV");
    expect(div.getByText("Live")).toBeInTheDocument();
    expect(div.getByText("1 override")).toBeInTheDocument();
    expect((await row("CONF")).getByText("Upcoming")).toBeInTheDocument();
    expect((await row("CONF")).getByText("No overrides")).toBeInTheDocument();
    // only a final round can be finalized
    expect(div.queryByRole("button")).not.toBeInTheDocument();
    expect((await row("CONF")).queryByRole("button")).not.toBeInTheDocument();
    const rounds = screen.getByTestId("rounds-section");
    const live = screen.getByTestId("live-stats-section");
    expect(rounds.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(rounds).getByRole("link", { name: "Stat overrides" })).toHaveAttribute(
      "href",
      "/commissioner/overrides",
    );
  });

  it("says rounds appear after the first update when there are none", async () => {
    setup(idleIngest);
    expect(await (await card()).findByText(/after the first stats update/)).toBeInTheDocument();
  });

  it("finalizes a final round after a confirmation, and shows the response in both cards", async () => {
    const finalizeRound = vi.fn(async () =>
      state([
        round(1, "WC", "finalized", { finalizedAt: "2026-01-14T12:00:00.000Z" }),
        round(2, "DIV", "upcoming"),
      ]),
    );
    const { user, ingest } = setup(state([round(1, "WC", "final"), round(2, "DIV", "upcoming")]), {
      finalizeRound,
    });
    await user.click(await (await row("WC")).findByRole("button", { name: "Finalize Wild Card" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Freeze Wild Card points? Late stat changes won't move them until you unfreeze.",
    );
    expect(finalizeRound).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Finalize" }));
    expect(finalizeRound).toHaveBeenCalledWith("s2026", 1);
    const wc = await row("WC");
    expect(await wc.findByText("Finalized")).toBeInTheDocument();
    expect(wc.getByText(/^Finalized Jan 1[34]$/)).toBeInTheDocument();
    expect(wc.getByRole("button", { name: "Unfreeze Wild Card" })).toBeInTheDocument();
    expect(wc.queryByRole("button", { name: /^Finalize/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // the Live stats card shares the state: no refetch needed
    expect(within(screen.getByTestId("live-round-WC")).getByText("Finalized")).toBeInTheDocument();
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("cancelling the confirmation changes nothing", async () => {
    const finalizeRound = vi.fn();
    const { user } = setup(state([round(1, "WC", "final")]), { finalizeRound });
    await user.click(await (await row("WC")).findByRole("button", { name: "Finalize Wild Card" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(finalizeRound).not.toHaveBeenCalled();
  });

  it("shows why a finalize was refused", async () => {
    const finalizeRound = vi.fn(async () => {
      throw new ApiError(409, "round_not_final", "x");
    });
    const { user } = setup(state([round(1, "WC", "final")]), { finalizeRound });
    await user.click(await (await row("WC")).findByRole("button", { name: "Finalize Wild Card" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Finalize" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(
      "A round can be finalized once all its games are final.",
    );
  });

  it("unfreezes a finalized round with a required reason", async () => {
    const unfreezeRound = vi.fn(async () => state([round(1, "WC", "final")]));
    const { user } = setup(
      state([round(1, "WC", "finalized", { finalizedAt: "2026-01-14T12:00:00.000Z" })]),
      { unfreezeRound },
    );
    await user.click(await (await row("WC")).findByRole("button", { name: "Unfreeze Wild Card" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Unfreeze" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter a reason");
    expect(unfreezeRound).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText("Reason"), "  ESPN corrected a TD  ");
    await user.click(within(dialog).getByRole("button", { name: "Unfreeze" }));
    expect(unfreezeRound).toHaveBeenCalledWith("s2026", 1, "ESPN corrected a TD");
    const wc = await row("WC");
    expect(await wc.findByRole("button", { name: "Finalize Wild Card" })).toBeInTheDocument();
    expect(wc.queryByText(/^Finalized (Jan|Feb)/)).not.toBeInTheDocument();
  });

  it("warns when ESPN changed stats after the round was finalized", async () => {
    setup(
      state([
        round(1, "WC", "finalized", {
          finalizedAt: "2026-01-14T12:00:00.000Z",
          providerChangedAt: "2026-01-15T03:00:00.000Z",
        }),
        round(2, "DIV", "final"),
      ]),
    );
    const wc = await row("WC");
    expect(await wc.findByText(/ESPN changed stats after you finalized this round/)).toBeVisible();
    expect(wc.getByRole("button", { name: "Unfreeze Wild Card" })).toBeInTheDocument();
    expect((await row("DIV")).queryByText(/ESPN changed stats/)).not.toBeInTheDocument();
  });
});
