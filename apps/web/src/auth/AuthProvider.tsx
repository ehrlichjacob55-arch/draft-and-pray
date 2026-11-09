import { Amplify } from "aws-amplify";
import {
  confirmSignIn,
  fetchAuthSession,
  signIn,
  signOut as amplifySignOut,
} from "aws-amplify/auth";
import { normalizeEmail } from "@dnp/contract";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { randomPassword } from "../lib/password";
import { useConfig, type AppConfig } from "../config";
import { AuthContext, type AuthContextValue, type AuthStatus, type SignInStep } from "./context";

export const DEV_EMAIL_KEY = "dnp.devEmail";
export const DEV_EMAIL_HEADER = "X-Dev-User-Email";

export function readDevEmail(): string | null {
  try {
    return localStorage.getItem(DEV_EMAIL_KEY);
  } catch {
    return null;
  }
}
function writeDevEmail(email: string | null): void {
  try {
    if (email) localStorage.setItem(DEV_EMAIL_KEY, email);
    else localStorage.removeItem(DEV_EMAIL_KEY);
  } catch {
    /* storage unavailable: dev session just won't persist */
  }
}

function configureAmplify(config: AppConfig): void {
  Amplify.configure({
    Auth: {
      Cognito: { userPoolId: config.cognitoUserPoolId, userPoolClientId: config.cognitoClientId },
    },
  });
}

/** Maps Cognito/Amplify errors to text a manager can act on. */
export function authErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  switch (name) {
    case "CodeMismatchException":
      return "That code is not correct. Check the email and try again.";
    case "ExpiredCodeException":
    case "NotAuthorizedException":
      return "That code has expired or is no longer valid. Request a new code.";
    case "UserNotFoundException":
      return "We could not find an account for that email. Ask your commissioner to add you.";
    case "LimitExceededException":
    case "TooManyRequestsException":
    case "TooManyFailedAttemptsException":
      return "Too many attempts. Wait a few minutes and try again.";
    default:
      return err instanceof Error && err.message
        ? err.message
        : "Sign-in failed. Please try again.";
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const config = useConfig();
  const local = config.env === "local";
  const [state, setState] = useState<{ status: AuthStatus; email: string | null }>({
    status: "loading",
    email: null,
  });
  const pendingEmail = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (local) {
      const email = readDevEmail();
      setState(email ? { status: "signedIn", email } : { status: "signedOut", email: null });
      return;
    }
    try {
      const session = await fetchAuthSession();
      const claim = session.tokens?.idToken?.payload.email;
      if (session.tokens?.idToken) {
        setState({ status: "signedIn", email: typeof claim === "string" ? claim : null });
      } else setState({ status: "signedOut", email: null });
    } catch {
      setState({ status: "signedOut", email: null });
    }
  }, [local]);

  useEffect(() => {
    if (!local) configureAmplify(config);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial session discovery
    void refresh();
  }, [config, local, refresh]);

  const afterStep = useCallback(
    async (step: string): Promise<SignInStep> => {
      if (step === "CONFIRM_SIGN_IN_WITH_EMAIL_CODE") return "code";
      if (step === "DONE") {
        await refresh();
        return "done";
      }
      throw new Error(`Unsupported sign-in step: ${step}`);
    },
    [refresh],
  );

  const startSignIn = useCallback(
    async (rawEmail: string): Promise<SignInStep> => {
      const email = normalizeEmail(rawEmail);
      pendingEmail.current = email;
      try {
        let { nextStep } = await signIn({
          username: email,
          options: { authFlowType: "USER_AUTH", preferredChallenge: "EMAIL_OTP" },
        });
        if (nextStep.signInStep === "CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION") {
          ({ nextStep } = await confirmSignIn({ challengeResponse: "EMAIL_OTP" }));
        }
        return await afterStep(nextStep.signInStep);
      } catch (err) {
        if (err instanceof Error && err.name === "UserAlreadyAuthenticatedException") {
          await refresh();
          return "done";
        }
        throw err;
      }
    },
    [afterStep, refresh],
  );

  const confirmCode = useCallback(
    async (code: string): Promise<void> => {
      const { nextStep } = await confirmSignIn({ challengeResponse: code.trim() });
      await afterStep(nextStep.signInStep);
    },
    [afterStep],
  );

  const resendCode = useCallback(async (): Promise<void> => {
    if (!pendingEmail.current) throw new Error("Enter your email first.");
    await startSignIn(pendingEmail.current);
  }, [startSignIn]);

  const welcomeSignIn = useCallback(
    async (username: string, code: string): Promise<void> => {
      try {
        await amplifySignOut(); // someone else may be signed in on this browser
      } catch {
        /* nothing to sign out */
      }
      let { nextStep } = await signIn({
        username,
        password: code,
        options: { authFlowType: "USER_AUTH", preferredChallenge: "PASSWORD" },
      });
      if (nextStep.signInStep === "CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION") {
        ({ nextStep } = await confirmSignIn({ challengeResponse: "PASSWORD" }));
      }
      if (nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") {
        ({ nextStep } = await confirmSignIn({ challengeResponse: randomPassword() }));
      }
      if (nextStep.signInStep !== "DONE") {
        throw new Error("We could not finish setting up your account. Please try signing in.");
      }
      await refresh();
    },
    [refresh],
  );

  const devSignIn = useCallback((rawEmail: string) => {
    const email = normalizeEmail(rawEmail);
    writeDevEmail(email);
    setState({ status: "signedIn", email });
  }, []);

  const getIdToken = useCallback(async (): Promise<string | null> => {
    if (local) return null;
    try {
      const session = await fetchAuthSession();
      return session.tokens?.idToken?.toString() ?? null;
    } catch {
      return null;
    }
  }, [local]);

  const signOut = useCallback(async (): Promise<void> => {
    if (local) writeDevEmail(null);
    else {
      try {
        await amplifySignOut();
      } catch {
        /* clear local state regardless */
      }
    }
    pendingEmail.current = null;
    setState({ status: "signedOut", email: null });
  }, [local]);

  const value = useMemo<AuthContextValue>(
    () => ({
      mode: local ? "local" : "cognito",
      status: state.status,
      email: state.email,
      getIdToken,
      signOut,
      startSignIn,
      confirmCode,
      resendCode,
      welcomeSignIn,
      devSignIn,
    }),
    [
      local,
      state,
      getIdToken,
      signOut,
      startSignIn,
      confirmCode,
      resendCode,
      welcomeSignIn,
      devSignIn,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
