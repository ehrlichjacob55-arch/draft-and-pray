import { expect, test, type Browser, type Page } from "@playwright/test";

const COMMISSIONER = "commish@local.test";

async function devSignIn(page: Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Dev sign in" }).click();
  await expect(page.getByTestId("signed-in-email")).toHaveText(email);
}

async function addManager(page: Page, first: string, last: string, email: string): Promise<void> {
  const form = page.getByRole("form", { name: "Add manager" });
  await form.getByLabel("First name").fill(first);
  await form.getByLabel("Last name").fill(last);
  await form.getByLabel("Email").fill(email);
  await form.getByRole("button", { name: "Add manager" }).click();
  // Local mode has no Cognito, so no email is sent: the account-less message is expected.
  await expect(page.getByRole("status")).toContainText(first);
  await expect(
    page.getByRole("list", { name: "Managers" }).getByText(email, { exact: true }),
  ).toBeVisible();
}

/** Local stand-in for clicking the emailed link: /welcome -> "Simulate invite link". */
async function simulateInvite(browser: Browser, email: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/welcome");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Simulate invite link" }).click();
  await expect(page).toHaveURL(/\/$/);
  return { ctx, page };
}

test("commissioner adds managers; they are auto-claimed, rename, and see team names only", async ({
  browser,
}) => {
  // Unique per run so re-runs against a persistent local DB do not collide.
  const run = Date.now().toString(36);
  const alexEmail = `alex+${run}@local.test`;
  const samEmail = `sam+${run}@local.test`;
  const renamed = `Renamed ${run}`;

  // --- Commissioner adds two managers ---
  const commishCtx = await browser.newContext();
  const commish = await commishCtx.newPage();
  await devSignIn(commish, COMMISSIONER);
  await commish.getByRole("link", { name: "Commissioner" }).first().click();
  await expect(commish.getByRole("heading", { name: "Commissioner", level: 2 })).toBeVisible();
  await addManager(commish, "Alex", "Example", alexEmail);
  await addManager(commish, "Sam", "Sample", samEmail);

  // --- Alex arrives: auto-claim greets with the default team name, then renames ---
  const alex = await simulateInvite(browser, alexEmail);
  const card = alex.page.getByTestId("welcome-card");
  await expect(card).toContainText(
    /Welcome to Local League 2026! Your team is Team Example( \d+)?/,
  );
  await card.getByLabel("Rename your team (optional)").fill(renamed);
  await card.getByRole("button", { name: "Save name" }).click();
  await expect(card).toContainText(`Your team is ${renamed}`);
  await card.getByRole("button", { name: "Looks good" }).click();
  await expect(card).toHaveCount(0);
  await expect(alex.page.getByText(/Your team:/)).toContainText(renamed);

  // --- Sam (a different manager) sees the renamed team, but no names or emails ---
  const sam = await simulateInvite(browser, samEmail);
  await expect(sam.page.getByTestId("welcome-card")).toContainText("Team Sample");
  const main = sam.page.locator("main");
  await expect(main.getByText(renamed)).toBeVisible();
  const text = (await main.textContent()) ?? "";
  expect(text).not.toContain("@");
  expect(text).not.toContain("Alex");

  // --- The commissioner's table shows both as joined with no actions ---
  await commish.reload();
  const row = commish.getByRole("listitem").filter({ hasText: alexEmail });
  await expect(row.getByTestId("manager-status")).toHaveText("joined");
  await expect(row.getByRole("button")).toHaveCount(0);

  await Promise.all([commishCtx.close(), alex.ctx.close(), sam.ctx.close()]);
});
