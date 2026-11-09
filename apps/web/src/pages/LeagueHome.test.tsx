import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { meMember, renderRoute, seasonData } from "../test/utils";

beforeEach(() => sessionStorage.clear());

const claim = [{ seasonId: "s2026", teamId: "t1", teamName: "Team Example" }];

describe("League home welcome card", () => {
  it("greets a newly claimed manager with league, year and team", async () => {
    renderRoute("/", {
      api: {
        me: async () => meMember("manager", claim),
        season: async () =>
          seasonData({ teams: [{ teamId: "t1", name: "Team Example", isMine: true }] }),
      },
    });
    const card = await screen.findByTestId("welcome-card");
    expect(card).toHaveTextContent("Welcome to Local League 2026! Your team is Team Example");
  });

  it("has no card when nothing was just claimed", async () => {
    renderRoute("/", { api: { me: async () => meMember(), season: async () => seasonData() } });
    await screen.findByTestId("team-count");
    expect(screen.queryByTestId("welcome-card")).not.toBeInTheDocument();
  });

  it("optionally renames inline and the card shows the new name", async () => {
    const user = userEvent.setup();
    const renameTeam = vi.fn(async () => ({ teamId: "t1", name: "Renamed" }));
    const season = vi
      .fn()
      .mockResolvedValueOnce(
        seasonData({ teams: [{ teamId: "t1", name: "Team Example", isMine: true }] }),
      )
      .mockResolvedValue(seasonData({ teams: [{ teamId: "t1", name: "Renamed", isMine: true }] }));
    renderRoute("/", { api: { me: async () => meMember("manager", claim), season, renameTeam } });
    const card = await screen.findByTestId("welcome-card");
    const input = within(card).getByLabelText("Rename your team (optional)");
    await user.clear(input);
    await user.type(input, "Renamed");
    await user.click(within(card).getByRole("button", { name: "Save name" }));
    expect(renameTeam).toHaveBeenCalledWith("s2026", "t1", "Renamed");
    await waitFor(() =>
      expect(screen.getByTestId("welcome-card")).toHaveTextContent("Your team is Renamed"),
    );
  });

  it("dismisses with Looks good and remembers it in sessionStorage", async () => {
    const user = userEvent.setup();
    const props = {
      api: {
        me: async () => meMember("manager", claim),
        season: async () =>
          seasonData({ teams: [{ teamId: "t1", name: "Team Example", isMine: true }] }),
      },
    };
    const first = renderRoute("/", props);
    await user.click(await screen.findByRole("button", { name: "Looks good" }));
    expect(screen.queryByTestId("welcome-card")).not.toBeInTheDocument();
    first.unmount();

    // Same tab session, /me no longer reports justClaimed: still dismissed.
    renderRoute("/", { api: { ...props.api, me: async () => meMember() } });
    await screen.findByTestId("team-count");
    expect(screen.queryByTestId("welcome-card")).not.toBeInTheDocument();
  });

  it("keeps the card across a reload until dismissed", async () => {
    const props = {
      season: async () =>
        seasonData({ teams: [{ teamId: "t1", name: "Team Example", isMine: true }] }),
    };
    const first = renderRoute("/", {
      api: { ...props, me: async () => meMember("manager", claim) },
    });
    await screen.findByTestId("welcome-card");
    first.unmount();
    renderRoute("/", { api: { ...props, me: async () => meMember() } });
    expect(await screen.findByTestId("welcome-card")).toBeInTheDocument();
  });
});

describe("League home PII", () => {
  it("renders team names only: no emails and no manager names", async () => {
    const { container } = renderRoute("/", {
      api: { me: async () => meMember("manager", claim), season: async () => seasonData() },
    });
    await screen.findByTestId("team-count");
    // The header shows the signed-in user's own email; everything in <main> must be email-free.
    const main = container.querySelector("main")!;
    expect(main.textContent).not.toMatch(/\S+@\S+\.\S+/);
    expect(main.textContent).toContain("Pray Hard");
    expect(main.textContent).not.toMatch(/\bpat\b/);
  });
});

describe("League home", () => {
  it("non-member: tells them to ask the commissioner", async () => {
    renderRoute("/", { api: { me: async () => ({ user: null, leagues: [], justClaimed: [] }) } });
    expect(await screen.findByText(/Ask your commissioner to add you/)).toBeInTheDocument();
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
          teams: [{ teamId: "t1", name: "New Name", isMine: true }],
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
