import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InviteView } from "@dnp/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { meMember, renderRoute, seasonData, type RouteOpts } from "../test/utils";

const invite = (token: string, status: InviteView["status"], extra: Partial<InviteView> = {}) => ({
  token,
  url: `http://api.example/join/${token}`,
  status,
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-15T00:00:00.000Z",
  ...extra,
});

afterEach(() => vi.restoreAllMocks());

function setup(over: NonNullable<RouteOpts["api"]> = {}) {
  return renderRoute("/commissioner", {
    api: {
      me: async () => meMember("commissioner"),
      season: async () => seasonData({ myRole: "commissioner" }),
      listInvites: async () => [
        invite("tokOpen", "open"),
        invite("tokPending", "pending", { pendingEmail: "p@example.com" }),
        invite("tokUsed", "used", { usedByDisplayName: "pat" }),
        invite("tokRevoked", "revoked"),
      ],
      ...over,
    },
  });
}

describe("Commissioner page", () => {
  it("is commissioner only", async () => {
    renderRoute("/commissioner", { api: { me: async () => meMember("manager") } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the commissioner");
  });

  it("lists invites with status chips and only offers actions on active ones", async () => {
    setup();
    const list = await screen.findByRole("list", { name: "Invites" });
    const chips = within(list)
      .getAllByTestId("invite-status")
      .map((c) => c.textContent);
    expect(chips).toEqual(["open", "pending", "used", "revoked"]);
    expect(within(list).getAllByRole("button", { name: "Copy link" })).toHaveLength(2);
    expect(within(list).getAllByRole("button", { name: "Revoke" })).toHaveLength(2);
    expect(within(list).getByText("p@example.com")).toBeInTheDocument();
    expect(within(list).getByText("pat")).toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    setup({ listInvites: async () => [] });
    expect(await screen.findByText(/No invites yet/)).toBeInTheDocument();
  });

  it("creates invites and refreshes the list", async () => {
    const user = userEvent.setup();
    const createInvites = vi.fn(async () => [invite("new1", "open"), invite("new2", "open")]);
    const listInvites = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([invite("new1", "open"), invite("new2", "open")]);
    setup({ createInvites, listInvites });
    await screen.findByText(/No invites yet/);
    const count = screen.getByLabelText("How many");
    await user.clear(count);
    await user.type(count, "2");
    await user.click(screen.getByRole("button", { name: "Create invites" }));
    expect(createInvites).toHaveBeenCalledWith("s2026", 2);
    await waitFor(() => expect(screen.getAllByTestId("invite-status")).toHaveLength(2));
  });

  it("shows season_full when creating too many", async () => {
    const user = userEvent.setup();
    setup({
      createInvites: async () => Promise.reject(new ApiError(409, "season_full", "full")),
    });
    await user.click(await screen.findByRole("button", { name: "Create invites" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("all 9 teams");
  });

  it("copies a link built from window.location.origin, not the API url", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    setup();
    const list = await screen.findByRole("list", { name: "Invites" });
    await user.click(within(list).getAllByRole("button", { name: "Copy link" })[0]!);
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/join/tokOpen`);
    expect(await screen.findByRole("button", { name: "Copied!" })).toBeInTheDocument();
  });

  it("shows the link for manual copy when the clipboard is blocked", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    setup();
    const list = await screen.findByRole("list", { name: "Invites" });
    await user.click(within(list).getAllByRole("button", { name: "Copy link" })[0]!);
    expect(await screen.findByTestId("manual-link")).toHaveTextContent("/join/tokOpen");
  });

  it("revokes after confirmation, and not when declined", async () => {
    const user = userEvent.setup();
    const revokeInvite = vi.fn(async () => ({ ok: true as const }));
    const listInvites = vi
      .fn()
      .mockResolvedValueOnce([invite("tokOpen", "open")])
      .mockResolvedValue([invite("tokOpen", "revoked")]);
    setup({ revokeInvite, listInvites });
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const btn = await screen.findByRole("button", { name: "Revoke" });
    await user.click(btn);
    expect(revokeInvite).not.toHaveBeenCalled();
    await user.click(btn);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(revokeInvite).toHaveBeenCalledWith("s2026", "tokOpen");
    await waitFor(() => expect(screen.getByTestId("invite-status")).toHaveTextContent("revoked"));
  });

  it("renames a team from the teams table", async () => {
    const user = userEvent.setup();
    const renameTeam = vi.fn(async () => ({ teamId: "t2", name: "Renamed" }));
    setup({ renameTeam });
    await user.click(await screen.findByRole("button", { name: "Rename Pray Hard" }));
    const input = screen.getByLabelText("New name for Pray Hard");
    await user.clear(input);
    await user.type(input, "Renamed");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(renameTeam).toHaveBeenCalledWith("s2026", "t2", "Renamed");
  });
});
