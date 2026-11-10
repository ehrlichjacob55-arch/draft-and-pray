import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ManagerView, ManagerWithDelivery } from "@dnp/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { draftData, meMember, renderRoute, seasonData, type RouteOpts } from "../test/utils";
import { parseBulk } from "./Commissioner";

const manager = (
  teamId: string,
  status: ManagerView["status"],
  over: Partial<ManagerView> = {},
) => ({
  teamId,
  teamName: `Team ${teamId}`,
  teamAbbr: `T${teamId.toUpperCase()}`,
  firstName: "Alex",
  lastName: `Example${teamId}`,
  email: `alex.${teamId}@example.com`,
  status,
  invitedAt: "2026-01-01T00:00:00.000Z",
  lastSentAt: "2026-01-01T00:00:00.000Z",
  claimedAt: status === "joined" ? "2026-01-02T00:00:00.000Z" : null,
  ...over,
});

const delivered = (m: ManagerView, emailSent: boolean): ManagerWithDelivery => ({
  ...m,
  emailSent,
});

afterEach(() => vi.restoreAllMocks());

function setup(over: NonNullable<RouteOpts["api"]> = {}) {
  return renderRoute("/commissioner", {
    api: {
      me: async () => meMember("commissioner"),
      season: async () => seasonData({ myRole: "commissioner" }),
      // Draft already running: the Draft setup section just links to the draft room.
      draft: async () => draftData({ myRole: "commissioner" }),
      listManagers: async () => [
        manager("a", "invited"),
        manager("b", "joined"),
        manager("c", "expired"),
      ],
      ...over,
    },
  });
}

async function fillAdd(user: ReturnType<typeof userEvent.setup>) {
  const form = await screen.findByRole("form", { name: "Add manager" });
  await user.type(within(form).getByLabelText("First name"), "Alex");
  await user.type(within(form).getByLabelText("Last name"), "Example");
  await user.type(within(form).getByLabelText("Email"), "Alex@Example.com");
  return form;
}

describe("Commissioner Managers", () => {
  it("is commissioner only", async () => {
    renderRoute("/commissioner", { api: { me: async () => meMember("manager") } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the commissioner");
  });

  it("lists managers with n/9 and only offers actions while not joined", async () => {
    setup();
    const list = await screen.findByRole("list", { name: "Managers" });
    expect(screen.getByTestId("manager-count")).toHaveTextContent("3/9");
    expect(
      within(list)
        .getAllByTestId("manager-status")
        .map((c) => c.textContent),
    ).toEqual(["invited", "joined", "expired"]);
    expect(within(list).getByText("alex.a@example.com")).toBeInTheDocument();
    const joined = within(list).getAllByRole("listitem")[1]!;
    expect(within(joined).queryByRole("button")).not.toBeInTheDocument();
    expect(within(list).getAllByRole("button", { name: /^Resend/ })).toHaveLength(2);
    expect(within(list).getAllByRole("button", { name: /^Edit/ })).toHaveLength(2);
    expect(within(list).getAllByRole("button", { name: /^Remove/ })).toHaveLength(2);
  });

  it("shows an empty state", async () => {
    setup({ listManagers: async () => [] });
    expect(await screen.findByText(/No managers yet/)).toBeInTheDocument();
  });

  it("adds a manager and says the email was sent", async () => {
    const user = userEvent.setup();
    const listManagers = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([manager("a", "invited")]);
    const addManager = vi.fn(async () => delivered(manager("a", "invited"), true));
    setup({ listManagers, addManager });
    await fillAdd(user);
    await user.click(screen.getByRole("button", { name: "Add manager" }));
    expect(addManager).toHaveBeenCalledWith("s2026", {
      firstName: "Alex",
      lastName: "Example",
      email: "alex@example.com",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Invitation email sent to");
    await waitFor(() => expect(screen.getByTestId("manager-count")).toHaveTextContent("1/9"));
  });

  it("existing account: explains they are added at next sign-in", async () => {
    const user = userEvent.setup();
    setup({ addManager: async () => delivered(manager("a", "invited"), false) });
    await fillAdd(user);
    await user.click(screen.getByRole("button", { name: "Add manager" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Alex already has an account — they'll be added at their next sign-in.",
    );
  });

  it("validates the form before calling the API", async () => {
    const user = userEvent.setup();
    const addManager = vi.fn();
    setup({ addManager });
    await user.click(await screen.findByRole("button", { name: "Add manager" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("first and last name");
    expect(addManager).not.toHaveBeenCalled();
  });

  it.each([
    ["email_already_added", 409, "already on a team"],
    ["season_full", 409, "all 9 teams"],
    ["season_not_setup", 409, "no longer in setup"],
    ["invite_failed", 502, "could not send the invitation"],
    ["team_name_taken", 409, "already uses that name"],
  ] as const)("add: friendly message for %s", async (code, status, text) => {
    const user = userEvent.setup();
    setup({ addManager: async () => Promise.reject(new ApiError(status, code, "raw")) });
    await fillAdd(user);
    await user.click(screen.getByRole("button", { name: "Add manager" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("resend: reports delivery", async () => {
    const user = userEvent.setup();
    const resendManager = vi.fn(async () => delivered(manager("a", "invited"), true));
    setup({ resendManager });
    await user.click(await screen.findByRole("button", { name: "Resend to Alex Examplea" }));
    expect(resendManager).toHaveBeenCalledWith("s2026", "a");
    expect(await screen.findByRole("status")).toHaveTextContent("Invitation email sent");
  });

  it("resend on a joined race shows the manager_joined message", async () => {
    const user = userEvent.setup();
    setup({ resendManager: async () => Promise.reject(new ApiError(409, "manager_joined", "x")) });
    await user.click(await screen.findByRole("button", { name: "Resend to Alex Examplea" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already joined");
  });

  it("edit: saves changed fields", async () => {
    const user = userEvent.setup();
    const updateManager = vi.fn(async () =>
      delivered(manager("a", "invited", { firstName: "Sam" }), true),
    );
    setup({ updateManager });
    await user.click(await screen.findByRole("button", { name: "Edit Alex Examplea" }));
    const form = screen.getByRole("form", { name: "Edit Alex Examplea" });
    const first = within(form).getByLabelText("First name");
    await user.clear(first);
    await user.type(first, "Sam");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(updateManager).toHaveBeenCalledWith("s2026", "a", {
      firstName: "Sam",
      lastName: "Examplea",
      email: "alex.a@example.com",
    });
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: /^Edit/ })).not.toBeInTheDocument(),
    );
  });

  it("edit: shows an error and stays open", async () => {
    const user = userEvent.setup();
    setup({
      updateManager: async () => Promise.reject(new ApiError(409, "email_already_added", "x")),
    });
    await user.click(await screen.findByRole("button", { name: "Edit Alex Examplea" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already on a team");
    expect(screen.getByRole("form", { name: "Edit Alex Examplea" })).toBeInTheDocument();
  });

  it("remove: confirms first, then removes", async () => {
    const user = userEvent.setup();
    const removeManager = vi.fn(async () => ({ ok: true as const }));
    const confirm = vi.spyOn(window, "confirm");
    setup({ removeManager });
    const remove = await screen.findByRole("button", { name: "Remove Alex Examplea" });

    confirm.mockReturnValueOnce(false);
    await user.click(remove);
    expect(removeManager).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    await user.click(remove);
    expect(removeManager).toHaveBeenCalledWith("s2026", "a");
    expect(await screen.findByRole("status")).toHaveTextContent("Removed Alex Examplea");
  });

  it("renames a team", async () => {
    const user = userEvent.setup();
    const renameTeam = vi.fn(async () => ({ teamId: "t2", name: "Pray Harder", abbr: "PRAY" }));
    setup({ renameTeam });
    await user.click(await screen.findByRole("button", { name: "Rename Pray Hard" }));
    const input = screen.getByLabelText("New name for Pray Hard");
    await user.clear(input);
    await user.type(input, "Pray Harder");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(renameTeam).toHaveBeenCalledWith("s2026", "t2", "Pray Harder", undefined);
  });

  it("edits a team abbreviation next to the name", async () => {
    const user = userEvent.setup();
    const renameTeam = vi.fn(async () => ({ teamId: "t2", name: "Pray Hard", abbr: "PH" }));
    setup({ renameTeam });
    await user.click(await screen.findByRole("button", { name: "Rename Pray Hard" }));
    const abbr = screen.getByLabelText("Team abbreviation");
    expect(abbr).toHaveValue("PRAY");
    await user.clear(abbr);
    await user.type(abbr, "ph");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(renameTeam).toHaveBeenCalledWith("s2026", "t2", "Pray Hard", "PH");
  });

  it("bulk add: previews then adds each line", async () => {
    const user = userEvent.setup();
    const addManager = vi.fn(async () => delivered(manager("a", "invited"), true));
    setup({ addManager, listManagers: async () => [] });
    await user.click(await screen.findByRole("button", { name: "Bulk add" }));
    await user.type(
      screen.getByLabelText(/Paste up to 9 lines/),
      "Alex,One,one@example.com\nSam,Two,two@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(
      within(screen.getByRole("list", { name: "Bulk preview" })).getAllByRole("listitem"),
    ).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Add 2" }));
    await waitFor(() => expect(addManager).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("status")).toHaveTextContent("Added 2 managers");
  });
});

describe("parseBulk", () => {
  it("parses good lines and rejects bad ones", () => {
    expect(parseBulk("A,B,a@example.com\n\n C , D , C@Example.com ")).toEqual({
      rows: [
        { firstName: "A", lastName: "B", email: "a@example.com" },
        { firstName: "C", lastName: "D", email: "c@example.com" },
      ],
    });
    expect(parseBulk("A,B")).toEqual({ error: "Line 1 should look like: First,Last,email." });
    expect(parseBulk("")).toHaveProperty("error");
    expect(parseBulk(Array(10).fill("A,B,a@example.com").join("\n"))).toHaveProperty("error");
  });
});
