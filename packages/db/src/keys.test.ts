import { describe, expect, it } from "vitest";
import * as k from "./keys";

describe("keys", () => {
  it("zero-pads numbers in sort keys", () => {
    expect(k.pickKey("S1", 7)).toEqual({ pk: "SEASON#S1", sk: "PICK#007" });
    expect(k.pickKey("S1", 90).sk).toBe("PICK#090");
    expect(k.rulesetKey("S1", 3).sk).toBe("RULESET#v003");
    expect(k.roundKey("S1", 2).sk).toBe("ROUND#2");
  });

  it("builds the documented formats", () => {
    expect(k.userKeys("u1", "a@b.c")).toEqual({
      pk: "USER#u1",
      sk: "PROFILE",
      gsi1pk: "EMAIL#a@b.c",
      gsi1sk: "USER",
    });
    expect(k.leagueMemberKey("L", "u")).toEqual({
      pk: "LEAGUE#L",
      sk: "MEMBER#u",
      gsi1pk: "USER#u",
      gsi1sk: "LEAGUE#L",
    });
    expect(k.seasonPointerKey("L", 2026).sk).toBe("SEASON#2026");
    expect(k.managerPrivateKey("S", "T")).toEqual({ pk: "SEASON#S", sk: "PRIVATE#MANAGER#T" });
    expect(k.pendingManagerGsi1("a@b.c", "S")).toEqual({
      gsi1pk: "PENDING#a@b.c",
      gsi1sk: "SEASON#S",
    });
    expect(k.gsiPendingPk("a@b.c")).toBe("PENDING#a@b.c");
    expect(k.rosterEntryKey("S", "T", "FLEX1", 1).sk).toBe("ROSTER#T#FLEX1#1");
    expect(k.statsKey("S", "g", "p").sk).toBe("STATS#g#p");
    expect(k.overrideKey("S", "g", "p", "rushYds").sk).toBe("OVERRIDE#g#p#rushYds");
    expect(k.teamScoreKey("S", 2, "T").sk).toBe("TEAMSCORE#2#T");
    expect(k.skPrefix.rosterOfTeam("T")).toBe("ROSTER#T#");
  });

  it("pick keys sort lexicographically in numeric order", () => {
    const sks = [90, 9, 10, 1].map((n) => k.pickKey("S", n).sk).sort();
    expect(sks).toEqual(["PICK#001", "PICK#009", "PICK#010", "PICK#090"]);
  });
});
