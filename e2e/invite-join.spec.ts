import { expect, test, type Page } from "@playwright/test";

const COMMISSIONER = "commish@local.test";

async function devSignIn(page: Page, email: string, path = "/signin") {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Dev sign in" }).click();
}

test("commissioner invites a manager who joins and appears on League home", async ({ browser }) => {
  // Unique per run so re-runs against a persistent local DB do not collide.
  const run = Date.now().toString(36);
  const managerEmail = `manager1+${run}@local.test`;
  const teamName = `E2E Team ${run}`;

  // --- Commissioner creates two invites and copies the last one ---
  const commishCtx = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const commish = await commishCtx.newPage();
  await devSignIn(commish, COMMISSIONER);
  await expect(commish.getByTestId("signed-in-email")).toHaveText(COMMISSIONER);

  await commish.getByRole("link", { name: "Commissioner" }).first().click();
  await expect(commish.getByRole("heading", { name: "Commissioner", level: 2 })).toBeVisible();

  const list = commish.getByRole("list", { name: "Invites" });
  await expect(list.or(commish.getByText(/No invites yet/))).toBeVisible(); // loaded
  // Tidy leftovers from earlier runs so the 9-team cap is not hit by stale open invites.
  commish.on("dialog", (d) => void d.accept());
  const revokes = list.getByRole("button", { name: "Revoke" });
  while ((await revokes.count()) > 0) {
    const before = await revokes.count();
    await revokes.first().click();
    await expect(revokes).toHaveCount(before - 1);
  }
  const openBefore = await list.getByRole("button", { name: "Copy link" }).count();
  const count = commish.getByLabel("How many");
  await count.fill("2");
  await commish.getByRole("button", { name: "Create invites" }).click();
  await expect(list.getByRole("button", { name: "Copy link" })).toHaveCount(openBefore + 2);

  await list.getByRole("button", { name: "Copy link" }).last().click();
  const link = await commish.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(new RegExp(`^${new URL(commish.url()).origin}/join/[A-Za-z0-9_-]{43}$`));

  // --- Manager opens the link in a fresh browser context ---
  const managerCtx = await browser.newContext();
  const manager = await managerCtx.newPage();
  await manager.goto(link);
  await expect(manager.getByRole("heading", { name: /^Join Local League 2026$/ })).toBeVisible();
  await manager.getByLabel("Email").fill(managerEmail);
  await manager.getByRole("button", { name: "Dev sign in" }).click();
  await manager.getByLabel("Team name").fill(teamName);
  await manager.getByRole("button", { name: "Join league" }).click();

  // --- League home shows the team and n/9 ---
  await expect(manager).toHaveURL(/\/$/);
  await expect(manager.getByText(/Your team:/)).toContainText(teamName);
  await expect(manager.getByTestId("team-count")).toHaveText(/^\d\/9$/);
  await expect(manager.getByRole("list").getByText(teamName)).toBeVisible();

  // The same link cannot be reused.
  const third = await browser.newContext();
  const reuse = await third.newPage();
  await reuse.goto(link);
  await expect(reuse.getByRole("alert")).toContainText("already been used");

  // Revoke the unused second invite so re-runs stay tidy.
  await commish.reload();
  await list.getByRole("button", { name: "Revoke" }).click();
  await expect(list.getByRole("button", { name: "Revoke" })).toHaveCount(0);

  await Promise.all([commishCtx.close(), managerCtx.close(), third.close()]);
});
