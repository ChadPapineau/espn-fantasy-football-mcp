// option-verdict.test.ts — the round-4 F7 / R4VS-5 (plan 07 E2 `swaps[].option_value.verdict`;
// research 05 §3.4 via the sibling): the option-value verdict is true in every branch. Before, a swap
// that benched a Monday-night starter with nothing left to open read "hold: the gain does not cover
// the option value of the later game" with an option worth 0 and a gain below 0 — a reply that read
// it back claimed value in waiting — and a swap to a later player read "commit: … keeps the option
// open" however many points it lost. The table covers each branch: the entrant locking first or
// later, an option worth 0 (with why: nothing opens after the news, or the status is not in doubt)
// or more, a gain ≥ the value, between 0 and the value, below 0, and below −value. The texts are
// fixed (no third-party data); each one says whether the swap gains or loses points whenever that,
// not the option, decides.
import { describe, expect, it } from "vitest";
import { optionVerdict, type NoOptionWhy } from "../../../src/domain/analytics/lineup.js";

const NOTHING = "nothing opens after his status is known";
const SURE = "his status is not in doubt";

describe("optionVerdict: true in every branch", () => {
  it.each<[boolean, number, number, NoOptionWhy, string]>([
    // the entrant's game locks first: committing gives up waiting for the later game
    [true, 3, 0, "nothing_opens", `commit: waiting has no option value (${NOTHING})`],
    [true, 0, 0, "nothing_opens", `commit: waiting has no option value (${NOTHING})`],
    [true, 3, 0, "not_in_doubt", `commit: waiting has no option value (${SURE})`],
    [
      true,
      -5.749,
      0,
      "nothing_opens",
      `hold: the swap loses expected points; waiting has no option value (${NOTHING})`,
    ],
    [
      true,
      -1,
      0,
      "not_in_doubt",
      `hold: the swap loses expected points; waiting has no option value (${SURE})`,
    ],
    [true, 3, 2.4, "nothing_opens", "commit: the gain covers the option value of waiting"],
    [true, 2.4, 2.4, "nothing_opens", "commit: the gain covers the option value of waiting"],
    [
      true,
      1,
      2.4,
      "nothing_opens",
      "hold: the gain does not cover the option value of the later game",
    ],
    [
      true,
      0,
      2.4,
      "nothing_opens",
      "hold: the gain does not cover the option value of the later game",
    ],
    [
      true,
      -14,
      2.4,
      "nothing_opens",
      "hold: the swap loses expected points and gives up the option value of the later game",
    ],
    // the entrant plays later: starting him keeps the option, so the swap is worth gain + value
    [false, 2, 0, "nothing_opens", `commit: the later game adds no option value (${NOTHING})`],
    [
      false,
      -2,
      0,
      "nothing_opens",
      `hold: the swap loses expected points; the later game adds no option value (${NOTHING})`,
    ],
    [
      false,
      -2,
      0,
      "not_in_doubt",
      `hold: the swap loses expected points; the later game adds no option value (${SURE})`,
    ],
    [false, 2, 1.5, "nothing_opens", "commit: starting the later player keeps the option open"],
    [false, 0, 1.5, "nothing_opens", "commit: starting the later player keeps the option open"],
    [
      false,
      -1,
      1.5,
      "nothing_opens",
      "commit: the option value of the later game covers the expected points the swap loses",
    ],
    [
      false,
      -1.5,
      1.5,
      "nothing_opens",
      "commit: the option value of the later game covers the expected points the swap loses",
    ],
    [
      false,
      -4,
      1.5,
      "nothing_opens",
      "hold: the swap loses more expected points than the option value of the later game",
    ],
  ])("inFirst %s, gain %d, value %d (%s)", (inFirst, gain, value, why, text) => {
    expect(optionVerdict({ inFirst, gain, value, why })).toBe(text);
  });

  it("never names the option as the reason to hold when it is worth 0, never 'commit' on a loss with no option", () => {
    for (const inFirst of [true, false])
      for (const gain of [-10, -0.001, 0, 0.001, 10])
        for (const why of ["nothing_opens", "not_in_doubt"] as const) {
          const v = optionVerdict({ inFirst, gain, value: 0, why });
          expect(v).not.toMatch(/does not cover|covers the|keeps the option open/);
          expect(v.startsWith("commit")).toBe(gain >= 0);
          if (gain < 0) expect(v).toContain("loses expected points");
        }
  });

  it("a negative gain is always said as lost points, whatever the value", () => {
    for (const inFirst of [true, false])
      for (const value of [0, 0.5, 3, 20])
        for (const gain of [-0.25, -2, -30]) {
          const v = optionVerdict({ inFirst, gain, value, why: "nothing_opens" });
          expect(v, `${String(inFirst)} ${String(gain)} ${String(value)}`).toMatch(
            /loses (more )?expected points|the expected points the swap loses/,
          );
        }
  });
});
