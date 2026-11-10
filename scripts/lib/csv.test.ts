import { describe, expect, it } from "vitest";
import { parseCsv, parsePlayersCsv, parseTeamsCsv } from "./csv";

const teamsCsv = () => {
  const rows = ["abbr,name,conference,seed"];
  for (let i = 0; i < 14; i++)
    rows.push(
      `${String.fromCharCode(65 + i).repeat(3)},"Team, ${i}",${i < 7 ? "AFC" : "NFC"},${(i % 7) + 1}`,
    );
  return rows.join("\r\n") + "\r\n";
};

describe("csv", () => {
  it("parses quotes, escapes and CRLF", () => {
    expect(parseCsv('a,"b ""q"", c",d\r\n\r\ne,f,g')).toEqual([
      ["a", 'b "q", c', "d"],
      ["e", "f", "g"],
    ]);
  });

  it("validates the 14-team field", () => {
    const teams = parseTeamsCsv(teamsCsv());
    expect(teams).toHaveLength(14);
    expect(teams[0]).toMatchObject({ abbr: "AAA", name: "Team, 0", conference: "AFC", seed: 1 });
    expect(() => parseTeamsCsv("abbr,name,conference,seed\nAAA,x,AFC,1")).toThrow(/14 teams/);
    expect(() => parseTeamsCsv(teamsCsv().replace("AFC,1", "AFC,9"))).toThrow(/seed must be 1-7/);
    expect(() => parseTeamsCsv(teamsCsv().replace("AFC,2", "AFC,1"))).toThrow(/seeds 1-7/);
    expect(() => parseTeamsCsv(teamsCsv().replace(",AFC,", ",XFL,"))).toThrow(/AFC or NFC/);
    expect(() => parseTeamsCsv("abbr,name\n")).toThrow(/missing column/);
    expect(() => parseTeamsCsv("")).toThrow(/empty/);
  });

  it("validates players and gives idempotent keys", () => {
    const teams = parseTeamsCsv(teamsCsv());
    const players = parsePlayersCsv(
      "playerId,name,position,nflTeam,injuryStatus\n,Ann Fiction,QB,AAA,\nx9,Bo Made-Up,K,BBB,Questionable\n",
      teams,
    );
    expect(players.map((p) => p.providerPlayerId)).toEqual(["csv:AAA:ann fiction:QB", "csv:x9"]);
    expect(players[1]?.injuryStatus).toBe("Questionable");
    expect(() => parsePlayersCsv("name,position,nflTeam\nA,DST,AAA", teams)).toThrow(/position/);
    expect(() => parsePlayersCsv("name,position,nflTeam\nA,QB,ZZZ", teams)).toThrow(
      /unknown nflTeam/,
    );
    expect(() => parsePlayersCsv("name,position,nflTeam\nA,QB,AAA\nA,QB,AAA", teams)).toThrow(
      /duplicate/,
    );
    expect(() => parsePlayersCsv("name,position,nflTeam\n,QB,AAA", teams)).toThrow(/name required/);
  });
});
