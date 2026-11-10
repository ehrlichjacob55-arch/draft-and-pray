import { describe, expect, it } from "vitest";
import { headshotUrl } from "./headshots";

describe("headshotUrl", () => {
  it("uses the Sleeper player image for numeric provider ids", () => {
    expect(headshotUrl({ position: "QB", nflTeam: "KC", providerPlayerId: "4046" })).toBe(
      "https://sleepercdn.com/content/nfl/players/4046.jpg",
    );
  });
  it("uses the team logo for a DST, mapping ESPN abbrs to Sleeper's", () => {
    expect(headshotUrl({ position: "DST", nflTeam: "DEN", providerPlayerId: null })).toBe(
      "https://sleepercdn.com/images/team_logos/nfl/den.png",
    );
    expect(headshotUrl({ position: "DST", nflTeam: "WSH", providerPlayerId: null })).toBe(
      "https://sleepercdn.com/images/team_logos/nfl/was.png",
    );
  });
  it("is null for synthetic, manual and fictional-team rows", () => {
    expect(
      headshotUrl({ position: "RB", nflTeam: "AAA", providerPlayerId: "syn:AAA-RB-1" }),
    ).toBeNull();
    expect(headshotUrl({ position: "WR", nflTeam: "KC", providerPlayerId: null })).toBeNull();
    expect(headshotUrl({ position: "DST", nflTeam: "AAA", providerPlayerId: null })).toBeNull();
  });
});
