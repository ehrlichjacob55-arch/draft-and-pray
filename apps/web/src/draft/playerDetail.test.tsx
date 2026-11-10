import type { AvailablePlayer } from "@dnp/contract";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlayerDetail, initials } from "./PlayerDetail";

const base: AvailablePlayer = {
  playerId: "p1",
  name: "Quinn Quarter",
  position: "QB",
  nflTeam: "AAA",
  seed: 2,
  injuryStatus: "Questionable",
  depthChartOrder: 1,
  rank: 3,
  stats: null,
  opponent: null,
  headshotUrl: "https://example.test/face.jpg",
};

const show = (player: AvailablePlayer) =>
  render(
    <PlayerDetail
      player={player}
      statsSeason={2025}
      inQueue={false}
      canQueue
      canDraft
      onToggleQueue={vi.fn()}
      onDraft={vi.fn()}
      onClose={vi.fn()}
    />,
  );

describe("PlayerDetail face card", () => {
  it("shows a lazy headshot with the name, team and injury chip", () => {
    const { container } = show(base);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("src", "https://example.test/face.jpg");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("alt", "");
    expect(screen.getByTestId("face-card")).toHaveTextContent("Quinn Quarter");
    expect(screen.getByTestId("face-card")).toHaveTextContent("AAA");
    expect(screen.getByTestId("face-injury")).toHaveTextContent("Questionable");
  });

  it("falls back to initials when there is no url or the image fails", () => {
    const none = show({ ...base, headshotUrl: null });
    expect(screen.getByTestId("avatar-fallback")).toHaveTextContent("QQ");
    none.unmount();
    const { container } = show(base);
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByTestId("avatar-fallback")).toHaveTextContent("QQ");
  });

  it("builds initials", () => {
    expect(initials("Cher")).toBe("C");
    expect(initials("  ")).toBe("?");
    expect(initials("Ja Marr Chase")).toBe("JC");
  });
});
