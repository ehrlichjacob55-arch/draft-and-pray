import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { meMember, renderRoute, seasonData } from "../test/utils";

describe("League home", () => {
  it("non-member: asks for an invite", async () => {
    renderRoute("/", { api: { me: async () => ({ user: null, leagues: [] }) } });
    expect(await screen.findByText(/Ask your commissioner for an invite link/)).toBeInTheDocument();
  });

  it("member: season card, teams n/9, my team (uses the most recent season)", async () => {
    const season = vi.fn(async () => seasonData());
    renderRoute("/", { api: { me: async () => meMember(), season } });
    expect(await screen.findByRole("heading", { name: "Local League" })).toBeInTheDocument();
    expect(season).toHaveBeenCalledWith("s2026");
    expect(screen.getByText(/2026 season/)).toBeInTheDocument();
    expect(screen.getByTestId("season-status")).toHaveTextContent("Setup");
    expect(screen.getByTestId("team-count")).toHaveTextContent("2/9");
    expect(screen.getByText("Pray Hard")).toBeInTheDocument();
    expect(screen.getByText(/Your team:/)).toHaveTextContent("Gridiron Gang");
    expect(screen.queryByRole("link", { name: /commissioner page/ })).not.toBeInTheDocument();
  });

  it("member can rename their team", async () => {
    const user = userEvent.setup();
    const renameTeam = vi.fn(async () => ({ teamId: "t1", name: "New Name" }));
    const season = vi
      .fn()
      .mockResolvedValueOnce(seasonData())
      .mockResolvedValue(
        seasonData({
          teams: [
            { teamId: "t1", name: "New Name", managerUserId: "u1", managerDisplayName: "me" },
          ],
        }),
      );
    renderRoute("/", { api: { me: async () => meMember(), season, renameTeam } });
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("New team name");
    await user.clear(input);
    await user.type(input, "New Name");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(renameTeam).toHaveBeenCalledWith("s2026", "t1", "New Name");
    expect(await screen.findByText(/Your team:/)).toHaveTextContent("New Name");
  });

  it("shows a rename error (duplicate name)", async () => {
    const user = userEvent.setup();
    renderRoute("/", {
      api: {
        me: async () => meMember(),
        season: async () => seasonData(),
        renameTeam: async () => Promise.reject(new ApiError(409, "team_name_taken", "dup")),
      },
    });
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already uses that name");
  });

  it("commissioner sees a link to the commissioner page", async () => {
    renderRoute("/", {
      api: {
        me: async () => meMember("commissioner"),
        season: async () => seasonData({ myRole: "commissioner" }),
      },
    });
    expect(await screen.findByRole("link", { name: /commissioner page/ })).toHaveAttribute(
      "href",
      "/commissioner",
    );
  });

  it("shows an error with retry when the season fails to load", async () => {
    const user = userEvent.setup();
    const season = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(500, "internal_error", "boom"))
      .mockResolvedValue(seasonData());
    renderRoute("/", { api: { me: async () => meMember(), season } });
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("team-count")).toBeInTheDocument());
  });

  it("shows an error when /me fails", async () => {
    renderRoute("/", {
      api: { me: async () => Promise.reject(new ApiError(0, "network_error", "x")) },
    });
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/Could not reach the server/)).toBeInTheDocument();
  });
});
