import { createContext, useContext } from "react";

export type AuthStatus = "loading" | "signedOut" | "signedIn";
export type SignInStep = "code" | "done";

export interface AuthContextValue {
  /** "local" = dev sign-in (no Cognito); "cognito" = emailed one-time code. */
  mode: "local" | "cognito";
  status: AuthStatus;
  email: string | null;
  getIdToken(): Promise<string | null>;
  signOut(): Promise<void>;
  /** Cognito: sends the code. Resolves "code" (enter it next) or "done". */
  startSignIn(email: string): Promise<SignInStep>;
  confirmCode(code: string): Promise<void>;
  resendCode(): Promise<void>;
  /**
   * One-step onboarding (docs/design/13 §1.3): signs in with the emailed temporary code, sets a random
   * throwaway password and ends signed in. Cognito mode only.
   */
  welcomeSignIn(username: string, code: string): Promise<void>;
  /** Local mode only. */
  devSignIn(email: string): void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
