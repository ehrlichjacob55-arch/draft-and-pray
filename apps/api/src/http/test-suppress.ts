/**
 * Test-only invitation bypass (docs/design/13 §7). The smoke script needs fresh Cognito users it
 * can sign in as without any email. It is honored ONLY when all hold:
 *   - APP_ENV is not prod,
 *   - the caller's ID token has `cognito:groups` containing `test-users`,
 *   - the request has `?testSuppress=1`,
 *   - (create/edit) the body has `testTemporaryPassword`.
 * Otherwise the flag and the password are silently ignored and a normal invitation is sent.
 */
import type { TestSuppress } from "../cognito";
import type { Config } from "../config";
import type { AuthUser } from "./auth";

export const TEST_GROUP = "test-users";

export function testModeAllowed(args: {
  config: Pick<Config, "APP_ENV">;
  user: Pick<AuthUser, "groups">;
  testSuppressQuery: string | undefined;
}): boolean {
  return (
    args.config.APP_ENV !== "prod" &&
    args.testSuppressQuery === "1" &&
    (args.user.groups ?? []).includes(TEST_GROUP)
  );
}

export function resolveTestSuppress(args: {
  config: Pick<Config, "APP_ENV">;
  user: Pick<AuthUser, "groups">;
  testSuppressQuery: string | undefined;
  testTemporaryPassword: string | undefined;
}): TestSuppress | undefined {
  if (!testModeAllowed(args) || !args.testTemporaryPassword) return undefined;
  return { temporaryPassword: args.testTemporaryPassword };
}
