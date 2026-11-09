import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { createCognitoAdmin, ensureCognitoUser, generatePassword, noopCognito } from "./cognito";

const cog = mockClient(CognitoIdentityProviderClient);
const client = new CognitoIdentityProviderClient({ region: "us-east-2" });
beforeEach(() => cog.reset());

const notFound = () => new UserNotFoundException({ message: "nope", $metadata: {} });

describe("generatePassword", () => {
  it("is 32 chars with upper, lower, digit and symbol, and differs per call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = generatePassword();
      seen.add(p);
      expect(p).toHaveLength(32);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^A-Za-z0-9]/);
    }
    expect(seen.size).toBe(50);
  });
});

describe("ensureCognitoUser", () => {
  it("creates a missing user (SUPPRESS, email_verified) and sets a permanent random password", async () => {
    cog.on(AdminGetUserCommand).rejects(notFound());
    cog.on(AdminCreateUserCommand).resolves({
      User: { UserStatus: "FORCE_CHANGE_PASSWORD", Attributes: [{ Name: "sub", Value: "sub-1" }] },
    });
    cog.on(AdminSetUserPasswordCommand).resolves({});
    const r = await ensureCognitoUser(client, "pool", "a@x.com");
    expect(r).toEqual({ sub: "sub-1", created: true });
    const create = cog.commandCalls(AdminCreateUserCommand)[0]!.args[0].input;
    expect(create).toMatchObject({
      UserPoolId: "pool",
      Username: "a@x.com",
      MessageAction: "SUPPRESS",
    });
    expect(create.UserAttributes).toContainEqual({ Name: "email_verified", Value: "true" });
    const set = cog.commandCalls(AdminSetUserPasswordCommand)[0]!.args[0].input;
    expect(set.Permanent).toBe(true);
    expect(set.Password).toHaveLength(32);
  });

  it("leaves a CONFIRMED user alone", async () => {
    cog.on(AdminGetUserCommand).resolves({
      UserStatus: "CONFIRMED",
      UserAttributes: [{ Name: "sub", Value: "sub-2" }],
    });
    const r = await createCognitoAdmin(client, "pool").ensureOtpReadyUser("a@x.com");
    expect(r).toBeUndefined();
    expect(cog.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
    expect(cog.commandCalls(AdminSetUserPasswordCommand)).toHaveLength(0);
  });

  it("fixes a user stuck in FORCE_CHANGE_PASSWORD", async () => {
    cog.on(AdminGetUserCommand).resolves({
      UserStatus: "FORCE_CHANGE_PASSWORD",
      UserAttributes: [{ Name: "sub", Value: "sub-3" }],
    });
    cog.on(AdminSetUserPasswordCommand).resolves({});
    await ensureCognitoUser(client, "pool", "a@x.com");
    expect(cog.commandCalls(AdminSetUserPasswordCommand)).toHaveLength(1);
  });

  it("uses a known password when given, even for existing users", async () => {
    cog.on(AdminGetUserCommand).resolves({
      UserStatus: "CONFIRMED",
      UserAttributes: [{ Name: "sub", Value: "sub-4" }],
    });
    cog.on(AdminSetUserPasswordCommand).resolves({});
    await ensureCognitoUser(client, "pool", "a@x.com", { password: "Known-Pass-123!" });
    expect(cog.commandCalls(AdminSetUserPasswordCommand)[0]!.args[0].input.Password).toBe(
      "Known-Pass-123!",
    );
  });
});

describe("noopCognito", () => {
  it("does nothing", async () => {
    await expect(noopCognito.ensureOtpReadyUser("a@x.com")).resolves.toBeUndefined();
  });
});
