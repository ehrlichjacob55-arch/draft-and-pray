import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { meMember, renderRoute } from "./test/utils";

describe("App shell", () => {
  it("shows header, email, sign out and nav for a signed-in manager", async () => {
    renderRoute("/", {
      api: { me: vi.fn(async () => ({ user: null, leagues: [] })) },
    });
    expect(await screen.findByRole("heading", { name: "Draft & Pray" })).toBeInTheDocument();
    expect(screen.getByText("me@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    for (const name of ["Home", "Draft room", "Standings", "My team", "Rules"]) {
      expect(screen.getByRole("link", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("link", { name: "Commissioner" })).not.toBeInTheDocument();
  });

  it("shows the Commissioner link only to commissioners", async () => {
    renderRoute("/", { api: { me: async () => meMember("commissioner"), season: neverEnding } });
    expect(await screen.findByRole("link", { name: "Commissioner" })).toBeInTheDocument();
  });

  it("keeps placeholder pages reachable", async () => {
    renderRoute("/standings", { api: { me: async () => ({ user: null, leagues: [] }) } });
    expect(await screen.findByRole("heading", { name: "Standings" })).toBeInTheDocument();
  });

  it("redirects signed-out visitors of protected routes to /signin?next=", async () => {
    const { router } = renderRoute("/commissioner", { auth: { status: "signedOut", email: null } });
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/signin");
    expect(router.state.location.search).toBe("?next=%2Fcommissioner");
  });

  it("shows a loading state while the session is being discovered", () => {
    renderRoute("/", { auth: { status: "loading", email: null } });
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
  });
});

function neverEnding() {
  return new Promise<never>(() => {});
}
