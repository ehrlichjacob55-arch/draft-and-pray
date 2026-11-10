import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Live draft, end to end against the LOCAL stack (docs/design/14 §8).
 *
 * Pre-step (done here in beforeAll): `pnpm admin draft-league setup --env local --pool synthetic ...`
 * creates a fresh scratch league with 9 joined teams, a synthetic fictional pool and the draft order,
 * so every run is independent of earlier runs. The commissioner and one manager draft in two real
 * browser contexts; the other seven teams use auto-draft (turned on through the API as those users).
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const apiUrl = process.env.E2E_API_URL ?? "http://localhost:3001";
const run = Date.now().toString(36);
const leagueName = `e2e ${run}`;
const slug = leagueName
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .slice(0, 24);
const commissionerEmail = `e2e-commish-${run}@local.test`;
// draft-league setup names its managers `<slug>-m<i>@local.test` (i = 1..8); the commissioner has team 1.
const managerEmail = (i: number) => `${slug}-m${i}@local.test`;

async function devSignIn(page: Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Dev sign in" }).click();
  await expect(page.getByTestId("signed-in-email")).toHaveText(email);
}

/** Board cell text keyed by overall pick number. */
async function boardText(page: Page): Promise<Record<string, string>> {
  const cells = await page.$$eval('[data-testid^="board-cell-"]', (els) =>
    els.map((el) => [
      el.getAttribute("data-testid")!.replace("board-cell-", ""),
      (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    ]),
  );
  return Object.fromEntries(cells);
}

/** Drafts the first enabled player in the list, if it is this page's turn. */
async function draftIfMyTurn(page: Page): Promise<boolean> {
  if (!(await page.getByText("Your pick!").isVisible())) return false;
  // The center shows the Players list while drafting (the Board is one toggle away).
  const button = page
    .locator('[data-testid^="player-"] button[aria-label^="Draft "]:not([disabled])')
    .first();
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Confirm pick" });
  await expect(dialog).toContainText("Draft ");
  await dialog.getByRole("button", { name: "Confirm pick" }).click();
  await expect(dialog).toHaveCount(0);
  return true;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  execFileSync(
    "pnpm",
    [
      "admin",
      "draft-league",
      "setup",
      "--env",
      "local",
      "--pool",
      "synthetic",
      "--email",
      commissionerEmail,
      "--league",
      leagueName,
      "--base-url",
      apiUrl,
    ],
    { cwd: repoRoot, stdio: "pipe", timeout: 120_000 },
  );
});

test("commissioner and a manager draft all 90 picks live; undo updates both", async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.setTimeout(420_000);

  const commishCtx = await browser.newContext();
  const managerCtx = await browser.newContext();
  const commish = await commishCtx.newPage();
  const manager = await managerCtx.newPage();

  try {
    // ---- Both sign in and land in the lobby ----
    await devSignIn(commish, commissionerEmail);
    await devSignIn(manager, managerEmail(1));
    await commish.goto("/draft");
    await manager.goto("/draft");
    for (const page of [commish, manager]) {
      await expect(page.getByTestId("draft-lobby")).toContainText("Waiting for the commissioner");
    }
    // Member-facing screens show team names only.
    expect((await manager.getByRole("main").textContent()) ?? "").not.toMatch(/@/);

    // ---- Commissioner starts the draft ----
    const control = commish.getByTestId("start-control");
    await expect(control).toBeVisible();
    await control.getByRole("button", { name: "Start draft" }).click();
    for (const page of [commish, manager]) {
      await expect(page.getByTestId("banner-pick")).toHaveText("Pick 1 of 90");
    }

    // ---- The v2 layout: roster left, players centre, on-the-clock strip above; queue + drafted right ----
    for (const page of [commish, manager]) {
      await expect(page.getByTestId("col-left").getByTestId("roster")).toBeVisible();
      await expect(page.getByTestId("col-center").getByTestId("players")).toBeVisible();
      await expect(page.getByTestId("otc-strip").getByTestId("otc-current")).toBeVisible();
      await expect(page.getByTestId("col-right").getByTestId("on-the-clock")).toHaveCount(0);
      await expect(page.getByTestId("col-right").getByTestId("queue")).toBeVisible();
      await expect(page.getByTestId("col-right").getByTestId("picks")).toBeVisible();
    }
    // The Players ⇄ Board toggle shows the grid and comes back with filters intact.
    const toggle = manager.getByRole("button", { name: "Players ⇄ Board" });
    await toggle.click();
    await expect(manager.getByTestId("board-cell-1")).toBeVisible();
    await toggle.click();
    await expect(manager.getByTestId("players")).toBeVisible();

    // ---- The other seven teams turn on auto-draft (as those users, through the API) ----
    const me = await commish.request.get("/api/me", {
      headers: { "X-Dev-User-Email": commissionerEmail },
    });
    expect(me.ok()).toBe(true);
    const seasonId = (
      (await me.json()) as { leagues: { name: string; seasons: { seasonId: string }[] }[] }
    ).leagues.find((l) => l.name === leagueName)?.seasons[0]?.seasonId;
    expect(seasonId).toBeTruthy();
    for (let i = 2; i <= 8; i++) {
      const res = await commish.request.put(`/api/seasons/${seasonId}/draft/auto-draft`, {
        headers: { "X-Dev-User-Email": managerEmail(i) },
        data: { enabled: true },
      });
      expect(res.ok(), `auto-draft for manager ${i}`).toBe(true);
    }

    // ---- The manager queues a player (private) ----
    await manager
      .locator('[data-testid^="player-"]')
      .first()
      .getByRole("button", { name: /^Add .* to queue$/ })
      .click();
    await expect(manager.getByRole("list", { name: "My queue" }).getByRole("listitem")).toHaveCount(
      1,
    );
    await expect(commish.getByTestId("queue-empty")).toBeVisible();

    // ---- Draft all 90 picks: the two humans pick on their turns, the rest are automatic ----
    const deadline = Date.now() + 360_000;
    while (!(await commish.getByTestId("draft-complete").isVisible())) {
      if (Date.now() > deadline) throw new Error("the draft did not complete in time");
      let acted = false;
      try {
        acted = (await draftIfMyTurn(commish)) || (await draftIfMyTurn(manager));
      } catch {
        // The turn moved on between looking and clicking (an auto-draft landed): look again.
      }
      if (!acted) await commish.waitForTimeout(150);
    }

    // ---- Both contexts see "Draft complete" and the identical full board (the centre defaults to it) ----
    for (const page of [commish, manager]) {
      await expect(page.getByTestId("draft-complete")).toContainText("Draft complete");
      await expect(page.getByRole("button", { name: "Players ⇄ Board" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      // Drafted players, newest first: pick #90 is on top.
      await expect(
        page.getByRole("list", { name: "Picks" }).getByRole("listitem").first(),
      ).toContainText("#90");
      await expect(page.locator('[data-testid^="board-cell-"]')).toHaveCount(90);
    }
    const complete = await boardText(commish);
    await expect.poll(() => boardText(manager)).toEqual(complete);
    expect(Object.values(complete).every((t) => t.length > 0 && !/^\d+$/.test(t))).toBe(true);

    // ---- Commissioner undoes the last pick; both update ----
    await commish.getByText("Commissioner controls").click();
    await commish.getByRole("button", { name: "Undo last pick" }).click();
    await commish
      .getByRole("group", { name: "Confirm undo" })
      .getByRole("button", { name: "Confirm undo" })
      .click();
    for (const page of [commish, manager]) {
      await expect(page.getByTestId("banner-pick")).toHaveText("Pick 90 of 90");
      await expect(page.getByTestId("board-cell-90")).toHaveText("90");
    }
    const afterUndo = await boardText(commish);
    await expect.poll(() => boardText(manager)).toEqual(afterUndo);
    const { 90: undone, ...rest } = afterUndo;
    const { 90: before, ...restBefore } = complete;
    expect(undone).toBe("90");
    expect(before).not.toBe("90");
    expect(rest).toEqual(restBefore);
  } finally {
    await Promise.all([commishCtx.close(), managerCtx.close()]);
  }
});
