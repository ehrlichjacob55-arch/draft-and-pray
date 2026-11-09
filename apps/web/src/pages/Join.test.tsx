import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { renderRoute } from "../test/utils";

const validInvite = { valid: true, leagueName: "Local League", seasonYear: 2026 };

describe("Join page", () => {
  it.each([
    ["not_found", "could not find this invite"],
    ["expired", "has expired"],
    ["used", "already been used"],
    ["revoked", "was revoked"],
  ] as const)("shows a friendly message for %s invites", async (reason, text) => {
    renderRoute("/join/tok", {
      auth: { status: "signedOut", email: null },
      api: { previewInvite: async () => ({ valid: false, reason }) },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("shows an error with retry when the preview fails", async () => {
    renderRoute("/join/tok", {
      auth: { status: "signedOut", email: null },
      api: { previewInvite: async () => Promise.reject(new ApiError(0, "network_error", "x")) },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("signed out: email -> register -> code -> team name -> accept -> home", async () => {
    const user = userEvent.setup();
    const register = vi.fn(async () => ({ ok: true as const }));
    const acceptInvite = vi.fn(async () => ({ seasonId: "s2026", teamId: "t1" }));
    const auth = {
      status: "signedOut" as const,
      email: null as string | null,
      startSignIn: vi.fn(async () => "code" as const),
      confirmCode: vi.fn(async () => {}),
    };
    const { router, setAuth } = renderRoute("/join/tok", {
      auth,
      api: {
        previewInvite: async () => validInvite,
        me: async () => ({ user: null, leagues: [] }),
        register,
        acceptInvite,
      },
    });
    expect(
      await screen.findByRole("heading", { name: "Join Local League 2026" }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Email"), "manager1@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(register).toHaveBeenCalledWith("tok", "manager1@example.com");
    await waitFor(() => expect(auth.startSignIn).toHaveBeenCalledWith("manager1@example.com"));

    await user.type(await screen.findByLabelText("6-digit code"), "123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(auth.confirmCode).toHaveBeenCalledWith("123456");

    setAuth({ status: "signedIn", email: "manager1@example.com" });
    await user.type(await screen.findByLabelText("Team name"), "  Pray Hard ");
    await user.click(screen.getByRole("button", { name: "Join league" }));
    expect(acceptInvite).toHaveBeenCalledWith("tok", "Pray Hard");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("local mode: register then dev sign-in", async () => {
    const user = userEvent.setup();
    const register = vi.fn(async () => ({ ok: true as const }));
    const devSignIn = vi.fn();
    renderRoute("/join/tok", {
      auth: { status: "signedOut", email: null, mode: "local", devSignIn },
      api: { previewInvite: async () => validInvite, register },
    });
    await user.type(await screen.findByLabelText("Email"), "manager1@local.test");
    await user.click(screen.getByRole("button", { name: "Dev sign in" }));
    expect(register).toHaveBeenCalledWith("tok", "manager1@local.test");
    expect(devSignIn).toHaveBeenCalledWith("manager1@local.test");
  });

  it("shows invite_bound when registering on an already-reserved invite", async () => {
    const user = userEvent.setup();
    renderRoute("/join/tok", {
      auth: { status: "signedOut", email: null },
      api: {
        previewInvite: async () => ({ ...validInvite, pendingEmail: "j***@example.com" }),
        register: async () => Promise.reject(new ApiError(409, "invite_bound", "bound")),
      },
    });
    expect(await screen.findByText(/reserved for j\*\*\*@example.com/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), "other@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already reserved");
  });

  it.each([
    ["email_mismatch", "reserved for a different email"],
    ["already_has_team", "already have a team"],
    ["team_name_taken", "already uses that name"],
    ["season_full", "all 9 teams"],
    ["season_not_setup", "no longer in setup"],
    ["invite_bound", "already reserved"],
  ] as const)("signed in: accept error %s is friendly", async (code, text) => {
    const user = userEvent.setup();
    const { router } = renderRoute("/join/tok", {
      api: {
        previewInvite: async () => validInvite,
        acceptInvite: async () => Promise.reject(new ApiError(409, code, "raw")),
      },
    });
    await user.type(await screen.findByLabelText("Team name"), "Pray Hard");
    await user.click(screen.getByRole("button", { name: "Join league" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(router.state.location.pathname).toBe("/join/tok");
  });
});
