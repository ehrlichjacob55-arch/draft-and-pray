import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ScoringResponse } from "@dnp/contract";
import { BUILTIN_RULESETS } from "@dnp/domain";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { draftData, meMember, renderRoute, seasonData, type RouteOpts } from "../test/utils";

const league = BUILTIN_RULESETS.league;

function scoringData(over: Partial<ScoringResponse["active"] & object> = {}, versions = 1) {
  return {
    seasonId: "s2026",
    active: {
      version: versions,
      name: "League rules",
      rounding: league.rounding,
      rules: structuredClone(league.rules) as Record<string, unknown>[],
      locked: false,
      lockedAt: null,
      note: null,
      ...over,
    },
    versions: Array.from({ length: versions }, (_, i) => ({
      version: i + 1,
      locked: i + 1 < versions || over.locked === true,
      active: i + 1 === versions,
      createdAt: "2026-03-01T00:00:00.000Z",
      note: i === 0 ? "Loaded the league rules" : null,
      lockedAt: null,
      by: "commissioner" as const,
    })),
  } satisfies ScoringResponse;
}

function setup(data: ScoringResponse | null, api: NonNullable<RouteOpts["api"]> = {}) {
  const user = userEvent.setup();
  const scoring = vi.fn(async () => data ?? { seasonId: "s2026", active: null, versions: [] });
  const fns = {
    seedScoring: vi.fn(async () => scoringData()),
    updateScoringVersion: vi.fn(async () => scoringData()),
    createScoringVersion: vi.fn(async () => scoringData()),
    lockScoringVersion: vi.fn(async () => scoringData()),
    activateScoringVersion: vi.fn(async () => scoringData()),
  };
  const r = renderRoute("/commissioner", {
    api: {
      me: async () => meMember("commissioner"),
      season: async () => seasonData({ myRole: "commissioner" }),
      draft: async () => draftData({ myRole: "commissioner" }),
      listManagers: async () => [],
      scoring,
      ...fns,
      ...api,
    },
  });
  return { user, scoring, ...fns, ...r };
}

const section = async () => within(await screen.findByTestId("scoring-section"));
const row = (name: string) =>
  screen.getAllByTestId("preview-row").find((r) => r.textContent?.includes(name))!;
const cell = (name: string, col: string) =>
  row(name).querySelector(`[data-col="${col}"]`)!.textContent;

async function setValue(user: ReturnType<typeof userEvent.setup>, label: string, value: string) {
  const input = await screen.findByLabelText(label);
  await user.clear(input);
  if (value) await user.type(input, value);
}

describe("Scoring section: no ruleset yet", () => {
  it("explains and loads the league rules, or the placeholder", async () => {
    const t = setup(null);
    const s = await section();
    expect(await s.findByText(/No scoring rules are set/)).toBeInTheDocument();
    await t.user.click(s.getByRole("button", { name: "Load league rules" }));
    expect(t.seedScoring).toHaveBeenCalledWith("s2026", "league");
    await waitFor(() => expect(t.scoring).toHaveBeenCalledTimes(2));
    expect(await s.findByRole("status")).toHaveTextContent("Loaded the league");
    await t.user.click(s.getByRole("button", { name: "Load placeholder rules" }));
    expect(t.seedScoring).toHaveBeenLastCalledWith("s2026", "placeholder");
  });

  it("shows a seed failure", async () => {
    const t = setup(null, {
      seedScoring: async () => {
        throw new ApiError(409, "ruleset_exists", "x");
      },
    });
    await t.user.click(await screen.findByRole("button", { name: "Load league rules" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already has scoring rules");
  });
});

describe("Scoring section: editor", () => {
  it("groups the rules and shows version, active and lock state", async () => {
    setup(scoringData());
    const s = await section();
    for (const g of [
      "Passing",
      "Rushing",
      "Receiving",
      "Touchdowns & 2-pt",
      "Turnovers",
      "Kicking",
      "Defense (DST)",
    ])
      expect(await s.findByRole("heading", { name: g })).toBeInTheDocument();
    expect(s.queryByRole("heading", { name: "Bonuses" })).not.toBeInTheDocument();
    expect(s.getByText("Version 1")).toBeInTheDocument();
    expect(s.getByText("Not locked")).toBeInTheDocument();
    expect(s.getByRole("combobox", { name: "Rounding" })).toHaveValue("2");
    expect(s.getByLabelText("Rushing yards points")).toHaveValue("1");
    expect(s.getByLabelText("Rushing yards per")).toHaveValue("10");
    expect(s.getByLabelText("Passing yards applies to QB")).toBeChecked();
    expect(s.getByLabelText("Passing yards applies to RB")).not.toBeChecked();
    expect(s.getAllByTestId("tier-row").length).toBeGreaterThan(5);
    expect(s.queryByTestId("unsaved")).not.toBeInTheDocument();
  });

  it("shows a live per-unit example", async () => {
    const t = setup(scoringData());
    const rule = within(await screen.findByTestId("rule-3"));
    expect(rule.getByTestId("per-unit-example")).toHaveTextContent("59 yds → 5.9 pts");
    await t.user.click(rule.getByLabelText(/Fractional/));
    expect(rule.getByTestId("per-unit-example")).toHaveTextContent("59 yds → 5 pts");
    await setValue(t.user, "Rushing yards per", "20");
    expect(rule.getByTestId("per-unit-example")).toHaveTextContent("119 yds → 5 pts");
    // clearing "per" keeps it a per-unit rule (with an error) instead of turning it into another type
    await setValue(t.user, "Rushing yards per", "");
    expect(rule.queryByTestId("per-unit-example")).not.toBeInTheDocument();
    expect(rule.getByLabelText("Rushing yards per")).toBeInTheDocument();
    expect(rule.getByRole("alert")).toHaveTextContent(/per/);
  });

  it("previews the effect of an unsaved edit and tracks unsaved state; Discard resets", async () => {
    const t = setup(scoringData());
    await screen.findByTestId("scoring-preview");
    expect(cell("Chuba Hubbard", "saved")).toBe("19.9");
    expect(cell("Chuba Hubbard", "edited")).toBe("19.9");
    expect(cell("Chuba Hubbard", "delta")).toBe("0");
    await setValue(t.user, "Rushing yards points", "2");
    // 46 rush yds: 9.2 + 12 + 2 rec + 1.3 = 24.5
    expect(cell("Chuba Hubbard", "saved")).toBe("19.9");
    expect(cell("Chuba Hubbard", "edited")).toBe("24.5");
    expect(cell("Chuba Hubbard", "delta")).toBe("+4.6");
    expect(cell("Matthew Stafford", "delta")).toBe("0");
    expect(screen.getByTestId("unsaved")).toBeInTheDocument();
    await t.user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("Rushing yards points")).toHaveValue("1");
    expect(cell("Chuba Hubbard", "edited")).toBe("19.9");
    expect(screen.queryByTestId("unsaved")).not.toBeInTheDocument();
  });

  it("shows an invalid tier inline, blocks saving and the preview of edits", async () => {
    const t = setup(scoringData());
    const idx = league.rules.findIndex((r) => r.stat === "def_pts_allowed");
    // band 1 is 0-0 and band 2 starts at 1: push band 2's start to 5 -> a gap (1..4).
    await setValue(t.user, "Points allowed band 2 from", "5");
    const rule = within(screen.getByTestId(`rule-${idx}`));
    expect(await rule.findByRole("alert")).toHaveTextContent(/gap in tiers/);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByText(/Fix the problems above/)).toBeInTheDocument();
    expect(cell("LAR DST", "edited")).toBe("–");
    expect(cell("LAR DST", "saved")).toBe("4");
    await setValue(t.user, "Points allowed band 2 from", "1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/Fix the problems above/)).not.toBeInTheDocument();
  });

  it("adds and removes tier bands, keeping the last one open-ended", async () => {
    const t = setup(scoringData());
    const idx = league.rules.findIndex((r) => r.stat === "def_pts_allowed");
    const rule = within(await screen.findByTestId(`rule-${idx}`));
    const bands = () => rule.getAllByTestId("tier-row").length;
    const before = bands();
    expect(rule.getByText("and up")).toBeInTheDocument();
    await t.user.click(rule.getByRole("button", { name: "Add band" }));
    expect(bands()).toBe(before + 1);
    expect(rule.getAllByText("and up")).toHaveLength(1);
    expect(rule.queryByRole("alert")).not.toBeInTheDocument();
    await t.user.click(
      rule.getByRole("button", { name: `Remove Points allowed band ${before + 1}` }),
    );
    expect(bands()).toBe(before);
    expect(rule.getByText("and up")).toBeInTheDocument();
    // remove from the middle: the next band takes over the range, so still valid
    await t.user.click(rule.getByRole("button", { name: "Remove Points allowed band 2" }));
    expect(bands()).toBe(before - 1);
    expect(rule.queryByRole("alert")).not.toBeInTheDocument();
    // remove the first: the next starts at 0
    await t.user.click(rule.getByRole("button", { name: "Remove Points allowed band 1" }));
    expect(rule.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("adds a rule from the stat list and removes a rule", async () => {
    const t = setup(scoringData());
    await screen.findByTestId("scoring-preview");
    await t.user.selectOptions(
      screen.getByLabelText("Stat"),
      "Rushing 2-pt".replace("Rushing 2-pt", "def_yds_allowed"),
    );
    await t.user.selectOptions(screen.getByLabelText("Type"), "bonus");
    await t.user.click(screen.getByRole("button", { name: "Add rule" }));
    // a threshold bonus lands in Bonuses
    const bonuses = within(screen.getByTestId("group-bonuses"));
    expect(bonuses.getByText("Yards allowed")).toBeInTheDocument();
    expect(bonuses.getByLabelText("Yards allowed at least")).toHaveValue("100");
    expect(screen.getByTestId("unsaved")).toBeInTheDocument();
    await t.user.click(bonuses.getByRole("button", { name: "Remove rule Yards allowed" }));
    expect(screen.queryByTestId("group-bonuses")).not.toBeInTheDocument();
    expect(screen.queryByTestId("unsaved")).not.toBeInTheDocument();
  });

  it("offers distance bands only for kicks and adds a per-event rule by default", async () => {
    const t = setup(scoringData());
    await screen.findByTestId("scoring-preview");
    await t.user.selectOptions(screen.getByLabelText("Stat"), "fg_made");
    expect(
      within(screen.getByLabelText("Type")).getByRole("option", { name: /kick distance/ }),
    ).toBeInTheDocument();
    await t.user.selectOptions(screen.getByLabelText("Type"), "distance_tiers");
    await t.user.selectOptions(screen.getByLabelText("Stat"), "rush_td");
    expect(screen.getByLabelText("Type")).toHaveValue("per_event");
    await t.user.click(screen.getByRole("button", { name: "Add rule" }));
    expect(screen.getAllByLabelText("Rushing TDs points")).toHaveLength(2);
  });

  it("toggles positions and rounding", async () => {
    const t = setup(scoringData());
    await screen.findByTestId("scoring-preview");
    await t.user.click(screen.getByLabelText("Rushing yards applies to RB"));
    expect(screen.getByLabelText("Rushing yards applies to RB")).toBeChecked();
    expect(screen.getByText("Applies to RB")).toBeInTheDocument();
    await t.user.click(screen.getByLabelText("Rushing yards applies to RB"));
    expect(screen.getAllByText("Applies to all positions").length).toBeGreaterThan(0);
    await t.user.selectOptions(screen.getByRole("combobox", { name: "Rounding" }), "0");
    expect(cell("Chuba Hubbard", "edited")).toBe("20");
  });

  it("keeps a number being typed and flags text that is not a number", async () => {
    const t = setup(scoringData());
    const input = (await screen.findByLabelText("Rushing yards points")) as HTMLInputElement;
    await t.user.clear(input);
    await t.user.type(input, "1.");
    expect(input.value).toBe("1.");
    await t.user.type(input, "5");
    expect(input.value).toBe("1.5");
    await t.user.clear(input);
    await t.user.type(input, "abc");
    expect(within(screen.getByTestId("rule-3")).getByRole("alert")).toBeInTheDocument();
    await t.user.clear(input);
    expect(within(screen.getByTestId("rule-3")).getByRole("alert")).toHaveTextContent(/points/);
  });
});

describe("Scoring section: advanced JSON", () => {
  it("stays in sync with the form and applies valid JSON on blur", async () => {
    const t = setup(scoringData());
    await screen.findByTestId("scoring-preview");
    const box = screen.getByLabelText("Rules as JSON") as HTMLTextAreaElement;
    expect(JSON.parse(box.value)).toEqual({ rounding: 2, rules: league.rules });
    await setValue(t.user, "Rushing yards points", "3");
    expect(JSON.parse(box.value).rules[3].points).toBe(3);
    const next = {
      rounding: 1,
      rules: [{ stat: "rush_td", points: 7 }],
    };
    fireEvent.change(box, { target: { value: JSON.stringify(next) } });
    fireEvent.blur(box);
    expect(screen.getByRole("combobox", { name: "Rounding" })).toHaveValue("1");
    expect(screen.getByLabelText("Rushing TDs points")).toHaveValue("7");
    expect(screen.queryByLabelText("Rushing yards points")).not.toBeInTheDocument();
  });

  it("reports invalid JSON and wrong shapes on blur without touching the form", async () => {
    setup(scoringData());
    await screen.findByTestId("scoring-preview");
    const box = screen.getByLabelText("Rules as JSON");
    const blurWith = (v: string) => {
      fireEvent.change(box, { target: { value: v } });
      fireEvent.blur(box);
    };
    blurWith("{ nope");
    expect(screen.getByText(/not valid JSON/)).toBeInTheDocument();
    blurWith("[1]");
    expect(screen.getByText(/must be an object/)).toBeInTheDocument();
    blurWith('{"rounding": 2}');
    expect(screen.getByText(/needs a "rules" list/)).toBeInTheDocument();
    blurWith('{"rounding": "x", "rules": []}');
    expect(screen.getByText(/"rounding" must be a number/)).toBeInTheDocument();
    expect(screen.getByLabelText("Rushing yards points")).toHaveValue("1");
    // rules the form cannot make sense of are kept and flagged, not dropped
    blurWith('{"rules": [{"stat": "nope", "points": 1}, 5]}');
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    expect(screen.getByRole("combobox", { name: "Rounding" })).toHaveValue("2");
  });

  it("blur without edits is a no-op", async () => {
    setup(scoringData());
    await screen.findByTestId("scoring-preview");
    fireEvent.blur(screen.getByLabelText("Rules as JSON"));
    expect(screen.queryByTestId("unsaved")).not.toBeInTheDocument();
  });
});

describe("Scoring section: saving", () => {
  it("unlocked: Save changes PUTs the active version", async () => {
    const t = setup(scoringData());
    await setValue(t.user, "Rushing yards points", "2");
    await t.user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(t.updateScoringVersion).toHaveBeenCalledTimes(1);
    const [seasonId, version, body] = t.updateScoringVersion.mock.calls[0] as unknown as [
      string,
      number,
      { rules: { stat: string; points: number }[]; rounding: number },
    ];
    expect([seasonId, version, body.rounding]).toEqual(["s2026", 1, 2]);
    expect(body.rules[3]).toMatchObject({ stat: "rush_yds", points: 2, per: 10 });
    expect(t.createScoringVersion).not.toHaveBeenCalled();
    expect(await screen.findByText("Saved changes to version 1.")).toBeInTheDocument();
  });

  it("locked: Save as new version POSTs with activate and the note", async () => {
    const t = setup(scoringData({ locked: true }));
    const s = await section();
    expect(await s.findAllByText("Locked")).toHaveLength(2); // header badge + history
    expect(s.queryByRole("button", { name: "Lock rules" })).not.toBeInTheDocument();
    expect(s.getByRole("button", { name: "Save as new version" })).toBeDisabled();
    await setValue(t.user, "Rushing yards points", "2");
    await t.user.type(s.getByLabelText(/Note for the new version/), "  rush up ");
    await t.user.click(s.getByRole("button", { name: "Save as new version" }));
    expect(t.updateScoringVersion).not.toHaveBeenCalled();
    expect(t.createScoringVersion).toHaveBeenCalledWith(
      "s2026",
      expect.objectContaining({ activate: true, note: "rush up", rounding: 2 }),
    );
    expect(await screen.findByText("Saved as version 2 and made it active.")).toBeInTheDocument();
  });

  it("locked, no note: the note is omitted", async () => {
    const t = setup(scoringData({ locked: true }));
    await setValue(t.user, "Rushing yards points", "2");
    await t.user.click(await screen.findByRole("button", { name: "Save as new version" }));
    const call = t.createScoringVersion.mock.calls[0] as unknown as [string, object];
    expect(call[1]).not.toHaveProperty("note");
  });

  it("shows server-side rule errors next to the right row", async () => {
    const t = setup(scoringData(), {
      updateScoringVersion: async () => {
        throw new ApiError(
          400,
          "validation_error",
          "The scoring rules have 2 problems",
          [],
          [
            { ruleIndex: 0, stat: "pass_yds", message: "per: boom" },
            { ruleIndex: null, stat: null, message: "something general" },
          ],
        );
      },
    });
    await setValue(t.user, "Rushing yards points", "2");
    await t.user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await within(screen.getByTestId("rule-0")).findByText("per: boom")).toBeInTheDocument();
    expect(screen.getByText("something general")).toBeInTheDocument();
    expect(screen.getByText("The scoring rules have 2 problems")).toBeInTheDocument();
    // editing clears the server's complaints
    await setValue(t.user, "Rushing yards points", "3");
    expect(screen.queryByText("per: boom")).not.toBeInTheDocument();
  });

  it("explains a lock that happened elsewhere", async () => {
    const t = setup(scoringData(), {
      updateScoringVersion: async () => {
        throw new ApiError(409, "ruleset_locked", "locked");
      },
    });
    await setValue(t.user, "Rushing yards points", "2");
    await t.user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Save your changes as a new version",
    );
  });
});

describe("Scoring section: lock, versions, leaving", () => {
  it("Lock rules needs a confirmation that explains the lifecycle", async () => {
    const t = setup(scoringData());
    const lock = await screen.findByRole("button", { name: "Lock rules" });
    await t.user.click(lock);
    const dialog = screen.getByRole("dialog", { name: "Lock version 1?" });
    expect(dialog).toHaveTextContent(/can no longer be edited.*new version/);
    await t.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(t.lockScoringVersion).not.toHaveBeenCalled();
    await t.user.click(lock);
    await t.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await t.user.click(lock);
    await t.user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Lock rules" }),
    );
    expect(t.lockScoringVersion).toHaveBeenCalledWith("s2026", 1);
    expect(await screen.findByText("Locked version 1.")).toBeInTheDocument();
  });

  it("Lock rules is unavailable while there are unsaved edits", async () => {
    const t = setup(scoringData());
    await setValue(t.user, "Rushing yards points", "2");
    expect(screen.getByRole("button", { name: "Lock rules" })).toBeDisabled();
  });

  it("lists versions and makes another one active after confirming", async () => {
    const t = setup(scoringData({}, 2));
    const history = within(await screen.findByRole("list", { name: "Version history" }));
    const items = history.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("v2");
    expect(items[0]).toHaveTextContent("Active");
    expect(items[1]).toHaveTextContent("v1");
    expect(items[1]).toHaveTextContent("Locked");
    expect(items[1]).toHaveTextContent("Loaded the league rules");
    expect(items[1]).toHaveTextContent("Mar 1, 2026");
    expect(items[1]).toHaveTextContent("by commissioner");
    expect(within(items[0]!).queryByRole("button")).not.toBeInTheDocument();
    await t.user.click(within(items[1]!).getByRole("button", { name: "Make version 1 active" }));
    const dialog = screen.getByRole("dialog", { name: "Make version 1 active?" });
    await t.user.click(within(dialog).getByRole("button", { name: "Make active" }));
    expect(t.activateScoringVersion).toHaveBeenCalledWith("s2026", 1);
  });

  it("a failed action closes the dialog and shows the error", async () => {
    const t = setup(scoringData(), {
      lockScoringVersion: async () => {
        throw new ApiError(409, "conflict", "x");
      },
    });
    await t.user.click(await screen.findByRole("button", { name: "Lock rules" }));
    await t.user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Lock rules" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("changed while you were working");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("warns before leaving with unsaved changes; Stay keeps them, Leave goes", async () => {
    const t = setup(scoringData());
    await setValue(t.user, "Rushing yards points", "2");
    act(() => void t.router.navigate("/standings"));
    const dialog = await screen.findByRole("dialog", { name: "Leave without saving?" });
    await t.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(t.router.state.location.pathname).toBe("/commissioner");
    expect(screen.getByLabelText("Rushing yards points")).toHaveValue("2");
    act(() => void t.router.navigate("/standings"));
    await t.user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Leave" }),
    );
    await waitFor(() => expect(t.router.state.location.pathname).toBe("/standings"));
  });

  it("does not warn when nothing changed, and warns on reload/close only when dirty", async () => {
    const t = setup(scoringData());
    await screen.findByTestId("scoring-preview");
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    await setValue(t.user, "Rushing yards points", "2");
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    act(() => void t.router.navigate("/standings"));
    await t.user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Leave" }),
    );
  });

  it("shows a load error with retry", async () => {
    let fail = true;
    const t = setup(null, {
      scoring: async () => {
        if (fail) throw new ApiError(500, "internal_error", "boom");
        return scoringData();
      },
    });
    expect(await screen.findByText("boom")).toBeInTheDocument();
    fail = false;
    await t.user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Version 1")).toBeInTheDocument();
  });
});

describe("Rules & scoring page (members)", () => {
  const renderRules = (
    data: ScoringResponse | Error,
    role: "manager" | "commissioner" = "manager",
  ) =>
    renderRoute("/rules", {
      api: {
        me: async () => meMember(role),
        scoring: async () => {
          if (data instanceof Error) throw data;
          return data;
        },
      },
    });

  it("renders the active ruleset in plain language with the version and lock badge", async () => {
    renderRules(scoringData({ locked: true }));
    expect(await screen.findByRole("heading", { name: "Rules & scoring" })).toBeInTheDocument();
    expect(await screen.findByText("Version 1")).toBeInTheDocument();
    expect(screen.getByText("Locked")).toBeInTheDocument();
    expect(screen.getByText("Rushing yards: 1 pt per 10 yds (fractional)")).toBeInTheDocument();
    expect(
      screen.getByText("Passing yards: 1 pt per 30 yds (fractional) (QB only)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Rushing TDs: 6 pts each")).toBeInTheDocument();
    expect(screen.getByText("Interceptions thrown: -1 pt each")).toBeInTheDocument();
    for (const h of [
      "Passing",
      "Rushing",
      "Receiving",
      "Touchdowns & 2-pt",
      "Turnovers",
      "Kicking",
      "Defense (DST)",
    ])
      expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
    const dst = within(screen.getByRole("table", { name: /Points allowed/ }));
    expect(dst.getAllByText("0").length).toBeGreaterThan(0);
    expect(dst.getByText("35+")).toBeInTheDocument();
    expect(dst.getByText("1–6")).toBeInTheDocument();
    const fg = within(screen.getByRole("table", { name: "Field goals made, by distance" }));
    expect(fg.getByText("0–39 yds")).toBeInTheDocument();
    expect(fg.getByText("50+ yds")).toBeInTheDocument();
    expect(screen.getByText(/rounded to 2 decimal places/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("describes whole-unit rules, bonuses, singular rounding and a not-yet-locked ruleset", async () => {
    renderRules(
      scoringData({
        rounding: 1,
        rules: [
          { stat: "rush_yds", points: 1, per: 10 },
          { stat: "rush_yds", gte: 100, points: 3 },
          { stat: "def_yds_allowed", gte: 100, points: -1 },
          { stat: "rec", points: 0.5, positions: ["RB", "WR"] },
        ],
      }),
    );
    expect(await screen.findByText("Not locked yet")).toBeInTheDocument();
    expect(
      screen.getByText("Rushing yards: 1 pt per 10 yds (whole units only)"),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bonuses" })).toBeInTheDocument();
    expect(screen.getByText("Rushing yards: +3 pts bonus for 100 yds or more")).toBeInTheDocument();
    expect(screen.getByText("Yards allowed: -1 pt bonus for 100 yds or more")).toBeInTheDocument();
    expect(screen.getByText("Receptions: 0.5 pts each (RB, WR only)")).toBeInTheDocument();
    expect(screen.getByText(/rounded to 1 decimal place\./)).toBeInTheDocument();
  });

  it("says so when no rules have been set; the commissioner gets a link", async () => {
    const empty = { seasonId: "s2026", active: null, versions: [] };
    const { unmount } = renderRules(empty);
    expect(await screen.findByText("Scoring rules haven't been set yet.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Commissioner page/ })).not.toBeInTheDocument();
    unmount();
    renderRules(empty, "commissioner");
    expect(await screen.findByRole("link", { name: /Commissioner page/ })).toHaveAttribute(
      "href",
      "/commissioner",
    );
  });

  it("handles a load error and rules it cannot read", async () => {
    const { unmount } = renderRules(new ApiError(500, "internal_error", "kaput"));
    expect(await screen.findByText("kaput")).toBeInTheDocument();
    unmount();
    renderRules(scoringData({ rules: [{ stat: "nope" }] }));
    expect(await screen.findByText(/can’t be shown/)).toBeInTheDocument();
  });

  it("says so when there is no season yet", async () => {
    renderRoute("/rules", {
      api: {
        me: async () => ({
          ...meMember("manager"),
          leagues: [{ ...meMember().leagues[0]!, seasons: [] }],
        }),
      },
    });
    expect(await screen.findByText("Scoring rules haven't been set yet.")).toBeInTheDocument();
  });

  it("shows a league error", async () => {
    renderRoute("/rules", { api: { me: async () => Promise.reject(new Error("no league")) } });
    expect(await screen.findByText("no league")).toBeInTheDocument();
  });
});
