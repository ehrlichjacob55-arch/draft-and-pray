/**
 * Live-draft smoke checks (docs/design/14 §8): a full 90-pick draft in a freshly reset Test League
 * through the real API, with a ticketed WebSocket watching for `draft_changed`.
 */
import { chooseAutopick, type Position, type Slot } from "@dnp/domain";
import type { Dynamo } from "@dnp/db";
import WebSocket from "ws";
import type { ApiClient, Json } from "../lib/api";
import { TEST_LEAGUE_NAME, testUserEmail, type EnvConfig } from "../lib/env";
import { importSyntheticPool } from "../lib/pool";
import type { TestUser } from "../lib/runtime";
import { resetTestLeague, seedTestLeague, type ResetOptions } from "../lib/test-league";
import type { CheckResult } from "./checks";

const PII_KEYS = ["email", "firstName", "lastName", "managerUserId", "userId", "madeByUserId"];

function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, into));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      collectKeys(v, into);
    }
  return into;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runDraftChecks(
  cfg: EnvConfig,
  db: Dynamo,
  api: ApiClient,
  users: TestUser[],
  cognito?: ResetOptions["cognito"],
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = async (name: string, fn: () => Promise<string | void>) => {
    try {
      results.push({ name, ok: true, detail: (await fn()) ?? "" });
    } catch (err) {
      results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };
  const eq = (actual: unknown, expected: unknown, what: string) => {
    if (actual !== expected)
      throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
  };
  const isAws = cfg.env !== "local";
  const commish = testUserEmail(1);
  const emails = users.map((u) => u.email);

  // Reset the Test League so the run is repeatable, then seed 9 joined teams.
  await resetTestLeague(db, { cognito });
  const { seasonId } = await seedTestLeague(cfg, db, api, users, cognito);
  const base = `/seasons/${seasonId}/draft`;
  const snap = async (as: string): Promise<Json> => {
    const r = await api.request("GET", base, { as });
    if (r.status !== 200) throw new Error(`snapshot ${as}: ${r.status} ${r.json?.error?.code}`);
    return r.json;
  };
  const code = (r: { json: Json }) => r.json?.error?.code as string;

  /** The pick the server's own auto-draft logic would make for `team` (client-side helper). */
  function bestPick(s: Json, teamId: string): { playerId: string; slot: Slot } {
    const filled = Object.entries(s.rosters[teamId] as Record<string, string | null>)
      .filter(([, v]) => v)
      .map(([k]) => k as Slot);
    const seeds: Record<string, number> = {};
    for (const p of s.available) if (p.seed !== null) seeds[p.nflTeam] = p.seed;
    const choice = chooseAutopick({
      queue: [],
      available: s.available.map((p: Json) => ({
        playerId: p.playerId,
        name: p.name,
        position: p.position as Position,
        nflTeam: p.nflTeam,
      })),
      filledSlots: filled,
      nflTeamSeeds: seeds,
    });
    if (!choice) throw new Error("no eligible player");
    return choice;
  }

  const teamOf: Record<string, string> = {};
  const emailOf: Record<string, string> = {};
  for (const e of emails) {
    const s = await snap(e);
    teamOf[e] = s.myTeamId;
    emailOf[s.myTeamId] = e;
  }

  await check("start is refused with reason codes before the order and pool exist", async () => {
    const r = await api.request("POST", `${base}/start`, { as: commish });
    eq(r.status, 409, "status");
    eq(code(r), "draft_not_ready", "code");
    for (const reason of ["order_incomplete", "pool_empty"])
      if (!r.json.error.reasons?.includes(reason)) throw new Error(`missing reason ${reason}`);
  });

  await check("managers cannot set the order, import the pool or start (403)", async () => {
    const m = emails[1] as string;
    eq(
      (await api.request("PUT", `${base}/order`, { as: m, body: { order: [] } })).status,
      403,
      "order",
    );
    eq(
      (
        await api.request("POST", `/seasons/${seasonId}/pool/import`, {
          as: m,
          body: { seasonYear: 2025 },
        })
      ).status,
      403,
      "import",
    );
    eq((await api.request("POST", `${base}/start`, { as: m })).status, 403, "start");
  });

  await check(
    isAws
      ? "pool import from the real sources (ESPN + Sleeper, season 2025) is idempotent"
      : "synthetic pool seeds the 14 fictional teams",
    async () => {
      if (isAws) {
        const r = await api.request("POST", `/seasons/${seasonId}/pool/import`, {
          as: commish,
          body: { seasonYear: 2025 },
        });
        eq(r.status, 200, `status (${code(r) ?? ""})`);
        eq(r.json.counts.teams, 14, "teams");
        if (r.json.counts.players < 200) throw new Error(`only ${r.json.counts.players} players`);
        const again = await api.request("POST", `/seasons/${seasonId}/pool/import`, {
          as: commish,
          body: { seasonYear: 2025 },
        });
        eq(again.json.counts.added, 0, "second import adds nothing");
        eq(again.json.counts.removed, 0, "second import removes nothing");
      } else {
        const c = await importSyntheticPool(db, seasonId, 2026);
        eq(c.teams, 14, "teams");
      }
      const list = await api.request("GET", `/seasons/${seasonId}/players`, { as: emails[2] });
      eq(list.json.teams.length, 14, "field");
      const dst = list.json.players.filter((p: Json) => p.position === "DST");
      eq(dst.length, 14, "DST rows");
      for (const pos of ["QB", "RB", "WR", "TE", "K"])
        if (!list.json.players.some((p: Json) => p.position === pos)) throw new Error(`no ${pos}`);
      return `${list.json.players.length} players`;
    },
  );

  const order: string[] = [];
  await check("commissioner sets the draft order (all 9 teams)", async () => {
    const s = await api.request("GET", `/seasons/${seasonId}`, { as: commish });
    order.push(...(s.json.teams as { teamId: string }[]).map((t) => t.teamId).reverse());
    const r = await api.request("PUT", `${base}/order`, { as: commish, body: { order } });
    eq(r.status, 200, "status");
    const d = await snap(emails[3] as string);
    eq(JSON.stringify(d.order.map((o: Json) => o.teamId)), JSON.stringify(order), "order");
    eq(d.startBlockers.length, 0, "blockers");
  });

  await check("start puts pick 1 on the clock; no clock by default", async () => {
    const r = await api.request("POST", `${base}/start`, { as: commish });
    eq(r.status, 200, "status");
    const d = await snap(commish);
    eq(d.status, "in_progress", "status");
    eq(d.onClockTeamId, order[0], "on clock");
    eq(d.clock, null, "clock");
    eq(
      (await api.request("PUT", `${base}/order`, { as: commish, body: { order } })).status,
      409,
      "order locked",
    );
    const season = await api.request("GET", "/me", { as: commish });
    const status = season.json.leagues.find((l: Json) => l.name === TEST_LEAGUE_NAME)?.seasons[0]
      ?.status;
    eq(status, "drafting", "season status");
  });

  const pickAs = (as: string, s: Json, extra: Json = {}) => {
    const team = extra.teamId ?? teamOf[as];
    const choice = bestPick(s, team);
    return api.request("POST", `${base}/picks`, {
      as,
      body: { playerId: choice.playerId, expectedPick: s.currentPick, ...extra },
    });
  };

  await check("pick errors: not_your_turn, stale_pick, then a manager pick", async () => {
    const s = await snap(commish);
    const turn = emailOf[s.onClockTeamId] as string;
    const other = emails.find((e) => e !== turn && teamOf[e] !== s.onClockTeamId) as string;
    const p = s.available[0].playerId;
    const wrong = await api.request("POST", `${base}/picks`, {
      as: other,
      body: { playerId: p, expectedPick: s.currentPick },
    });
    eq(wrong.status, 409, "status");
    eq(code(wrong), "not_your_turn", "code");
    const stale = await api.request("POST", `${base}/picks`, {
      as: turn,
      body: { playerId: p, expectedPick: s.currentPick + 5 },
    });
    eq(code(stale), "stale_pick", "stale code");
    const ok = await pickAs(turn, s);
    eq(ok.status, 200, `pick (${code(ok) ?? ""})`);
    eq(ok.json.pick.madeBy, "manager", "madeBy");
    eq(ok.json.currentPick, 2, "next pick");
  });

  await check("player_taken and commissioner pick for the on-clock team", async () => {
    const s = await snap(commish);
    const taken = s.picks[0].playerId as string;
    const turn = emailOf[s.onClockTeamId] as string;
    const r = await api.request("POST", `${base}/picks`, {
      as: turn,
      body: { playerId: taken, expectedPick: s.currentPick },
    });
    eq(code(r), "player_taken", "code");
    const cp = await pickAs(commish, s, { teamId: s.onClockTeamId });
    eq(cp.status, 200, `commissioner pick (${code(cp) ?? ""})`);
    eq(cp.json.pick.madeBy === "commissioner" || turn === commish, true, "madeBy");
  });

  await check("90 s clock: starts on the current pick, alert-only, clearable", async () => {
    const before = Date.now();
    const r = await api.request("POST", `${base}/clock`, { as: commish });
    eq(r.status, 200, "status");
    const s = await snap(commish);
    const { startedAt, expiresAt, seconds, expired } = s.clock;
    eq(seconds, 90, "seconds");
    eq(Date.parse(expiresAt) - Date.parse(startedAt), 90_000, "expiresAt - startedAt");
    eq(expired, false, "expired");
    if (Math.abs(Date.parse(startedAt) - before) > 60_000) throw new Error("clock start is off");
    eq((await api.request("DELETE", `${base}/clock`, { as: commish })).status, 200, "clear");
    eq((await snap(commish)).clock, null, "cleared");
  });

  await check("a queue is private to its team", async () => {
    const s = await snap(emails[4] as string);
    const ids = s.available.slice(5, 8).map((p: Json) => p.playerId);
    const put = await api.request("PUT", `${base}/queue`, {
      as: emails[4],
      body: { playerIds: ids },
    });
    eq(put.status, 200, "put");
    eq(JSON.stringify((await snap(emails[4] as string)).myQueue), JSON.stringify(ids), "own queue");
    for (const other of [emails[5], commish, emails[6]] as string[]) {
      eq((await snap(other)).myQueue.length, 0, `queue seen by ${other}`);
      eq(
        (await api.request("GET", `${base}/queue`, { as: other })).json.playerIds.length,
        0,
        "GET",
      );
    }
  });

  await check("the snapshot contains no PII keys or email-like values", async () => {
    const r = await api.request("GET", base, { as: emails[7] });
    const keys = collectKeys(r.json);
    for (const k of PII_KEYS) if (keys.has(k)) throw new Error(`snapshot has key "${k}"`);
    if (/@/.test(JSON.stringify(r.json))) throw new Error("snapshot has an @");
    return `${keys.size} distinct keys`;
  });

  await check(
    "ticketed WebSocket: single-use ticket, subscribe, draft_changed on a pick",
    async () => {
      const t1 = await api.request("POST", "/realtime/ticket", { as: emails[5] });
      eq(t1.status, 200, "ticket status");
      const { ticket, wsUrl } = t1.json as { ticket: string; wsUrl: string };
      const messages: Json[] = [];
      const ws = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`);
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
          ws.once("unexpected-response", (_r, res) =>
            reject(new Error(`handshake ${res.statusCode}`)),
          );
        });
        ws.on("message", (d) => messages.push(JSON.parse(String(d))));
        ws.send(JSON.stringify({ action: "subscribe", channel: `draft:${seasonId}` }));
        for (let i = 0; i < 100 && !messages.some((m) => m.type === "subscribed"); i++)
          await sleep(100);
        if (!messages.some((m) => m.type === "subscribed")) throw new Error("no subscribed ack");

        // The same ticket must not work twice.
        const reuse = await new Promise<string>((resolve) => {
          const ws2 = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`);
          ws2.once("open", () => {
            ws2.close();
            resolve("opened");
          });
          ws2.once("unexpected-response", (_r, res) => resolve(`rejected ${res.statusCode}`));
          ws2.once("error", () => resolve("rejected"));
        });
        if (reuse === "opened") throw new Error("a used ticket was accepted");

        const s = await snap(commish);
        const pick = await pickAs(commish, s, { teamId: s.onClockTeamId });
        eq(pick.status, 200, `pick (${code(pick) ?? ""})`);
        for (let i = 0; i < 100 && !messages.some((m) => m.type === "draft_changed"); i++)
          await sleep(100);
        const ev = messages.find((m) => m.type === "draft_changed");
        if (!ev) throw new Error("no draft_changed event");
        if (!(ev.version > s.version)) throw new Error(`version ${ev.version} <= ${s.version}`);
        if (/@/.test(JSON.stringify(ev))) throw new Error("event has an @");
        return `${wsUrl.split("?")[0]} v${ev.version}`;
      } finally {
        ws.close();
      }
    },
  );

  await check(
    "auto-draft chain completes all 90 picks (one manual team picks its own)",
    async () => {
      const manual = emails[8] as string;
      for (const e of emails) {
        if (e === manual) continue;
        const r = await api.request("PUT", `${base}/auto-draft`, {
          as: e,
          body: { enabled: true },
        });
        eq(r.status, 200, `auto-draft ${e}`);
      }
      for (let i = 0; i < 40; i++) {
        const s = await snap(commish);
        if (s.status === "complete") break;
        const turn = emailOf[s.onClockTeamId] as string;
        if (turn !== manual)
          throw new Error(`chain stalled with ${turn} on the clock at pick ${s.currentPick}`);
        const r = await pickAs(manual, s);
        eq(r.status, 200, `manual pick ${s.currentPick} (${code(r) ?? ""})`);
      }
      const s = await snap(commish);
      eq(s.status, "complete", "status");
      eq(s.picks.length, 90, "picks");
      eq(new Set(s.picks.map((p: Json) => p.playerId)).size, 90, "unique players");
      for (const [teamId, roster] of Object.entries(
        s.rosters as Record<string, Record<string, string | null>>,
      ))
        if (Object.values(roster).some((v) => !v)) throw new Error(`roster ${teamId} is not full`);
      const auto = s.picks.filter((p: Json) => p.madeBy === "autopick").length;
      if (auto < 50) throw new Error(`only ${auto} autopicks`);
      const me = await api.request("GET", "/me", { as: commish });
      eq(
        me.json.leagues.find((l: Json) => l.name === TEST_LEAGUE_NAME)?.seasons[0]?.status,
        "in_progress",
        "season status",
      );
      return `${auto} autopicks`;
    },
  );

  await check("undo after completion reopens pick 90", async () => {
    const r = await api.request("POST", `${base}/undo`, { as: commish });
    eq(r.status, 200, "status");
    eq(r.json.status, "in_progress", "draft status");
    eq(r.json.currentPick, 90, "current pick");
    const s = await snap(commish);
    eq(s.picks.length, 89, "picks");
    const me = await api.request("GET", "/me", { as: commish });
    eq(
      me.json.leagues.find((l: Json) => l.name === TEST_LEAGUE_NAME)?.seasons[0]?.status,
      "drafting",
      "season status",
    );
  });

  await check("redraft clears the picks and returns the draft to the lobby", async () => {
    const bad = await api.request("POST", `${base}/reset`, {
      as: commish,
      body: { confirm: "no" },
    });
    eq(bad.status, 400, "wrong confirmation");
    const r = await api.request("POST", `${base}/reset`, {
      as: commish,
      body: { confirm: "REDRAFT" },
    });
    eq(r.status, 200, `reset (${code(r) ?? ""})`);
    eq(r.json.status, "scheduled", "draft status");
    eq(r.json.picksCleared, 89, "picks cleared");
    const s = await snap(commish);
    eq(s.status, "scheduled", "snapshot status");
    eq(s.picks.length, 0, "picks");
    eq(s.currentPick, 1, "current pick");
    eq(s.order.length, 9, "order kept");
    eq(s.startBlockers.length, 0, "ready to start again");
    const again = await api.request("POST", `${base}/reset`, {
      as: commish,
      body: { confirm: "REDRAFT" },
    });
    eq(again.status, 409, "second reset refused before a new start");
    const me = await api.request("GET", "/me", { as: commish });
    eq(
      me.json.leagues.find((l: Json) => l.name === TEST_LEAGUE_NAME)?.seasons[0]?.status,
      "setup",
      "season status",
    );
  });

  return results;
}
