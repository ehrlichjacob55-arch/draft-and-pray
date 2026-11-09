import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createCognitoAdmin,
  ensureCognitoUser,
  generatePassword,
  generateTemporaryPassword,
  noopCognito,
} from "./cognito";

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

describe("generateTemporaryPassword", () => {
  it("is 20 URL-unreserved chars with every required class, over many samples", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const p = generateTemporaryPassword();
      seen.add(p);
      expect(p).toHaveLength(20);
      expect(p).toMatch(/^[A-Za-z0-9._~-]+$/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[-_.~]/);
    }
    expect(seen.size).toBe(2000);
  });
});

describe("ensureCognitoUser", () => {
  it("creates a missing user (SUPPRESS, email_verified) and sets a permanent random password", async () => {
    cog.on(AdminGetUserCommand).rejects(notFound());
    cog.on(AdminCreateUserCommand).resolves({
      User: { UserStatus: "FORCE_CHANGE_PASSWORD", Attributes: [{ Name: "sub", Value: "sub-1" }] },
    });
    cog.on(AdminSetUserPasswordCommand).resolves({});
    const r = await ensureCognitoUser(client, "pool", "a@example.com");
    expect(r).toEqual({ sub: "sub-1", created: true });
    const create = cog.commandCalls(AdminCreateUserCommand)[0]!.args[0].input;
    expect(create).toMatchObject({
      UserPoolId: "pool",
      Username: "a@example.com",
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
    const r = await createCognitoAdmin(client, "pool").ensureOtpReadyUser("a@example.com");
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
    await ensureCognitoUser(client, "pool", "a@example.com");
    expect(cog.commandCalls(AdminSetUserPasswordCommand)).toHaveLength(1);
  });

  it("uses a known password when given, even for existing users", async () => {
    cog.on(AdminGetUserCommand).resolves({
      UserStatus: "CONFIRMED",
      UserAttributes: [{ Name: "sub", Value: "sub-4" }],
    });
    cog.on(AdminSetUserPasswordCommand).resolves({});
    await ensureCognitoUser(client, "pool", "a@example.com", { password: "Known-Pass-123!" });
    expect(cog.commandCalls(AdminSetUserPasswordCommand)[0]!.args[0].input.Password).toBe(
      "Known-Pass-123!",
    );
  });
});

describe("noopCognito", () => {
  it("does nothing and reports no email sent", async () => {
    await expect(noopCognito.ensureOtpReadyUser("a@example.com")).resolves.toBeUndefined();
    const meta = { leagueName: "L", seasonYear: "2026", teamName: "T" };
    await expect(
      noopCognito.inviteNewUser({ email: "a@example.com", clientMetadata: meta }),
    ).resolves.toEqual({ existing: true, emailSent: false });
    await expect(noopCognito.deleteIfUnconfirmed("u")).resolves.toBe(false);
  });
});

const meta = { leagueName: "League", seasonYear: "2026", teamName: "Team Example" };
const exists = () => new UsernameExistsException({ message: "exists", $metadata: {} });

describe("inviteNewUser", () => {
  it("creates the user with email_verified, EMAIL delivery and client metadata; returns the opaque username", async () => {
    cog.on(AdminCreateUserCommand).resolves({ User: { Username: "uuid-1" } });
    const r = await createCognitoAdmin(client, "pool").inviteNewUser({
      email: "a@example.com",
      clientMetadata: meta,
    });
    expect(r).toEqual({ username: "uuid-1", existing: false, emailSent: true });
    const input = cog.commandCalls(AdminCreateUserCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      UserPoolId: "pool",
      Username: "a@example.com",
      DesiredDeliveryMediums: ["EMAIL"],
      ClientMetadata: meta,
    });
    expect(input.UserAttributes).toEqual([
      { Name: "email", Value: "a@example.com" },
      { Name: "email_verified", Value: "true" },
    ]);
    expect(input.MessageAction).toBeUndefined();
    expect(input.TemporaryPassword).toMatch(/^[A-Za-z0-9._~-]{20}$/);
  });

  it("an existing CONFIRMED user: no email, existing true, nothing resent", async () => {
    cog.on(AdminCreateUserCommand).rejects(exists());
    cog.on(AdminGetUserCommand).resolves({ Username: "uuid-2", UserStatus: "CONFIRMED" });
    const r = await createCognitoAdmin(client, "pool").inviteNewUser({
      email: "a@example.com",
      clientMetadata: meta,
    });
    expect(r).toEqual({ username: "uuid-2", existing: true, emailSent: false });
    expect(cog.commandCalls(AdminCreateUserCommand)).toHaveLength(1);
  });

  it("an existing user still in FORCE_CHANGE_PASSWORD gets the invitation re-sent", async () => {
    cog.on(AdminCreateUserCommand).rejectsOnce(exists()).resolves({});
    cog
      .on(AdminGetUserCommand)
      .resolves({ Username: "uuid-3", UserStatus: "FORCE_CHANGE_PASSWORD" });
    const r = await createCognitoAdmin(client, "pool").inviteNewUser({
      email: "a@example.com",
      clientMetadata: meta,
    });
    expect(r).toEqual({ username: "uuid-3", existing: true, emailSent: true });
    const resend = cog.commandCalls(AdminCreateUserCommand)[1]!.args[0].input;
    expect(resend).toMatchObject({
      Username: "uuid-3",
      MessageAction: "RESEND",
      ClientMetadata: meta,
    });
  });

  it("test suppress: SUPPRESS + TemporaryPassword, no email, and never resends an existing user", async () => {
    cog.on(AdminCreateUserCommand).resolves({ User: { Username: "uuid-4" } });
    const admin = createCognitoAdmin(client, "pool");
    const r = await admin.inviteNewUser({
      email: "a@example.com",
      clientMetadata: meta,
      testSuppress: { temporaryPassword: "Temp-Pass-123" },
    });
    expect(r).toEqual({ username: "uuid-4", existing: false, emailSent: false });
    expect(cog.commandCalls(AdminCreateUserCommand)[0]!.args[0].input).toMatchObject({
      MessageAction: "SUPPRESS",
      TemporaryPassword: "Temp-Pass-123",
    });

    cog.reset();
    cog.on(AdminCreateUserCommand).rejects(exists());
    cog.on(AdminGetUserCommand).resolves({ Username: "u", UserStatus: "FORCE_CHANGE_PASSWORD" });
    const again = await admin.inviteNewUser({
      email: "a@example.com",
      clientMetadata: meta,
      testSuppress: { temporaryPassword: "Temp-Pass-123" },
    });
    expect(again.emailSent).toBe(false);
    expect(cog.commandCalls(AdminCreateUserCommand)).toHaveLength(1);
  });

  it("propagates other errors", async () => {
    cog.on(AdminCreateUserCommand).rejects(new Error("throttled"));
    await expect(
      createCognitoAdmin(client, "pool").inviteNewUser({
        email: "a@example.com",
        clientMetadata: meta,
      }),
    ).rejects.toThrow("throttled");
  });
});

describe("resendInvite", () => {
  it("uses MessageAction RESEND with the same client metadata", async () => {
    cog.on(AdminCreateUserCommand).resolves({});
    const r = await createCognitoAdmin(client, "pool").resendInvite({
      email: "a@example.com",
      username: "uuid-1",
      clientMetadata: meta,
    });
    expect(r).toEqual({ username: "uuid-1", existing: true, emailSent: true });
    expect(cog.commandCalls(AdminCreateUserCommand)[0]!.args[0].input).toMatchObject({
      Username: "uuid-1",
      MessageAction: "RESEND",
      DesiredDeliveryMediums: ["EMAIL"],
      ClientMetadata: meta,
    });
    expect(cog.commandCalls(AdminCreateUserCommand)[0]!.args[0].input.TemporaryPassword).toMatch(
      /^[A-Za-z0-9._~-]{20}$/,
    );
  });

  it("reports emailSent false when the user is already confirmed", async () => {
    const err = Object.assign(new Error("state"), { name: "UnsupportedUserStateException" });
    cog.on(AdminCreateUserCommand).rejects(err);
    const r = await createCognitoAdmin(client, "pool").resendInvite({
      email: "a@example.com",
      username: "uuid-1",
      clientMetadata: meta,
    });
    expect(r.emailSent).toBe(false);
  });

  it("re-creates a user that no longer exists", async () => {
    cog
      .on(AdminCreateUserCommand)
      .rejectsOnce(notFound())
      .resolves({ User: { Username: "uuid-new" } });
    const r = await createCognitoAdmin(client, "pool").resendInvite({
      email: "a@example.com",
      username: "gone",
      clientMetadata: meta,
    });
    expect(r).toEqual({ username: "uuid-new", existing: false, emailSent: true });
  });
});

describe("deleteIfUnconfirmed", () => {
  it("deletes only FORCE_CHANGE_PASSWORD users", async () => {
    const admin = createCognitoAdmin(client, "pool");
    cog.on(AdminGetUserCommand).resolves({ UserStatus: "FORCE_CHANGE_PASSWORD" });
    cog.on(AdminDeleteUserCommand).resolves({});
    expect(await admin.deleteIfUnconfirmed("uuid-1")).toBe(true);
    expect(cog.commandCalls(AdminDeleteUserCommand)[0]!.args[0].input).toEqual({
      UserPoolId: "pool",
      Username: "uuid-1",
    });
    cog.reset();
    cog.on(AdminGetUserCommand).resolves({ UserStatus: "CONFIRMED" });
    expect(await admin.deleteIfUnconfirmed("uuid-1")).toBe(false);
    expect(cog.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it("is false for a missing user", async () => {
    cog.on(AdminGetUserCommand).rejects(notFound());
    expect(await createCognitoAdmin(client, "pool").deleteIfUnconfirmed("x")).toBe(false);
  });
});
