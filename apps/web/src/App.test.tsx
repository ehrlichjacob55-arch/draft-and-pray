import { render, screen } from "@testing-library/react";
import { createMemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { routes } from "./routes";

const config = {
  apiBaseUrl: "/api",
  wsUrl: "ws://localhost:3002",
  cognitoUserPoolId: "",
  cognitoClientId: "",
  region: "us-east-1",
  env: "local",
};

function mockFetch(health: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url === "/config.json" ? config : health;
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("App shell", () => {
  it("renders header, nav and API health", async () => {
    mockFetch({ status: "ok", env: "local", db: "ok" });
    render(<App router={createMemoryRouter(routes, { initialEntries: ["/"] })} />);

    expect(await screen.findByRole("heading", { name: "Draft & Pray" })).toBeInTheDocument();
    for (const name of ["Draft room", "Standings", "My team", "Rules", "Commissioner", "Sign in"]) {
      expect(screen.getByRole("link", { name })).toBeInTheDocument();
    }
    expect(await screen.findByText("ok (local)")).toBeInTheDocument();
  });

  it("shows an error when the db is unhealthy", async () => {
    mockFetch({ status: "ok", env: "local", db: "error" });
    render(<App router={createMemoryRouter(routes, { initialEntries: ["/"] })} />);
    expect(await screen.findByText("error")).toBeInTheDocument();
  });
});
