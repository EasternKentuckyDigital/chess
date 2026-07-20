import assert from "node:assert/strict";
import test from "node:test";
import { evaluationBarState } from "../static/lib/eval-bar.js";

const WHITE_FEN = "8/8/8/8/8/8/8/4K2k w - - 0 1";
const BLACK_FEN = "8/8/8/8/8/8/8/4K2k b - - 0 1";

test("evaluation bar converts UCI scores to White perspective", () => {
  const white = evaluationBarState({ cp: 150, mate: null }, WHITE_FEN);
  const black = evaluationBarState({ cp: 150, mate: null }, BLACK_FEN);
  assert.ok(white.whiteShare > 50);
  assert.ok(black.whiteShare < 50);
  assert.equal(white.label, "+1.5");
  assert.equal(black.label, "−1.5");
});

test("evaluation bar displays mate and preserves board orientation", () => {
  const state = evaluationBarState({ cp: null, mate: 3 }, BLACK_FEN, true);
  assert.equal(state.label, "−M3");
  assert.equal(state.whiteShare, 3);
  assert.equal(state.flipped, true);
});

test("evaluation bar has a neutral unavailable state", () => {
  assert.deepEqual(evaluationBarState(null, WHITE_FEN), {
    active: false,
    flipped: false,
    whiteShare: 50,
    label: "—",
    advantage: "equal",
  });
});
