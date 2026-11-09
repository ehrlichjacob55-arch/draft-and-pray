import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiContext } from "../api";
import { ConfigContext } from "../config";
import { routes } from "../routes";
import { baseConfig, fakeApi } from "../test/utils";
import { AuthProvider } from "./AuthProvider";

const amplify = vi.hoisted(() => ({
  configure: vi.fn(),
  signIn: vi.fn(),
  confirmSignIn: vi.fn(),
  fetchAuthSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify", () => ({ Amplify: { configure: amplify.configure } }));
vi.mock("aws-amplify/auth", () => ({
  signIn: amplify.signIn,
  confirmSignIn: amplify.confirmSignIn,
  fetchAuthSession: amplify.fetchAuthSession,
  signOut: amplify.signOut,
}));

const signedOutSession = { tokens: undefined };
const signedInSession = {
  tokens: { idToken: { payload: { email: "me@example.com" }, toString: () => "id-token" } },
};

function renderAt(path: string, env = "dev") {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const api = fakeApi({ me: async () => ({ user: null, leagues: [] }) });
  render(
    <ConfigContext.Provider value={{ ...baseConfig, env }}>
      <AuthProvider>
        <ApiContext.Provider value={api}>
          <RouterProvider router={router} />
        </ApiContext.Provider>
      </AuthProvider>
    </ConfigContext.Provider>,
  );
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  amplify.fetchAuthSession.mockResolvedValue(signedOutSession);
});

describe("Cognito email-code sign-in", () => {
  it("configures Amplify from config.json", async () => {
    renderAt("/signin");
    await screen.findByRole("button", { name: "Send code" });
    expect(amplify.configure).toHaveBeenCalledWith({
      Auth: { Cognito: { userPoolId: "pool", userPoolClientId: "client" } },
    });
  });

  it("email -> code -> signed in, then goes to ?next", async () => {
    const user = userEvent.setup();
    amplify.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_EMAIL_CODE" },
    });
    amplify.confirmSignIn.mockImplementation(async () => {
      amplify.fetchAuthSession.mockResolvedValue(signedInSession);
      return { isSignedIn: true, nextStep: { signInStep: "DONE" } };
    });
    const router = renderAt("/signin?next=%2Fstandings");

    await user.type(await screen.findByLabelText("Email"), " Me@Example.com ");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(amplify.signIn).toHaveBeenCalledWith({
      username: "me@example.com",
      options: { authFlowType: "USER_AUTH", preferredChallenge: "EMAIL_OTP" },
    });

    await user.type(await screen.findByLabelText("6-digit code"), "123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(amplify.confirmSignIn).toHaveBeenCalledWith({ challengeResponse: "123456" });

    await waitFor(() => expect(router.state.location.pathname).toBe("/standings"));
    expect(await screen.findByText("me@example.com")).toBeInTheDocument();
  });

  it("selects EMAIL_OTP when Cognito asks for a first factor", async () => {
    const user = userEvent.setup();
    amplify.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: "CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION" },
    });
    amplify.confirmSignIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_EMAIL_CODE" },
    });
    renderAt("/signin");
    await user.type(await screen.findByLabelText("Email"), "me@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByLabelText("6-digit code")).toBeInTheDocument();
    expect(amplify.confirmSignIn).toHaveBeenCalledWith({ challengeResponse: "EMAIL_OTP" });
  });

  it("shows friendly errors for wrong and expired codes, and can resend", async () => {
    const user = userEvent.setup();
    amplify.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_EMAIL_CODE" },
    });
    renderAt("/signin");
    await user.type(await screen.findByLabelText("Email"), "me@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    const codeInput = await screen.findByLabelText("6-digit code");

    amplify.confirmSignIn.mockRejectedValueOnce(
      Object.assign(new Error("bad"), { name: "CodeMismatchException" }),
    );
    await user.type(codeInput, "000000");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not correct");

    amplify.confirmSignIn.mockRejectedValueOnce(
      Object.assign(new Error("expired"), { name: "ExpiredCodeException" }),
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("expired"));

    await user.click(screen.getByRole("button", { name: "Resend code" }));
    await waitFor(() => expect(amplify.signIn).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("A new code is on its way.")).toBeInTheDocument();
  });

  it("signs out through Amplify", async () => {
    const user = userEvent.setup();
    amplify.fetchAuthSession.mockResolvedValue(signedInSession);
    amplify.signOut.mockResolvedValue(undefined);
    const router = renderAt("/standings");
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(amplify.signOut).toHaveBeenCalled();
    await waitFor(() => expect(router.state.location.pathname).toBe("/signin"));
  });
});

describe("Local dev sign-in", () => {
  it("signs in with email only, stores it, and never calls Amplify", async () => {
    const user = userEvent.setup();
    const router = renderAt("/signin", "local");
    await user.type(await screen.findByLabelText("Email"), "Commish@local.test");
    await user.click(screen.getByRole("button", { name: "Dev sign in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(localStorage.getItem("dnp.devEmail")).toBe("commish@local.test");
    expect(amplify.configure).not.toHaveBeenCalled();
    expect(amplify.signIn).not.toHaveBeenCalled();
    expect(amplify.fetchAuthSession).not.toHaveBeenCalled();
  });

  it("restores a stored dev session", async () => {
    localStorage.setItem("dnp.devEmail", "commish@local.test");
    renderAt("/", "local");
    expect(await screen.findByText("commish@local.test")).toBeInTheDocument();
  });
});
