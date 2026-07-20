import test from "node:test";
import assert from "node:assert/strict";
import { classifyPuzzleEligibility } from "../static/lib/puzzle-rules.js";

test("creates a blunder puzzle at a three-pawn loss", () => {
  assert.deepEqual(
    classifyPuzzleEligibility({ bestValue: 90, playedValue: -210 }),
    { eligible: true, category: "Blunder", loss: 300 },
  );
});

test("does not create a puzzle below the loss threshold", () => {
  assert.deepEqual(
    classifyPuzzleEligibility({ bestValue: 120, playedValue: -179 }),
    { eligible: false, category: null, loss: 299 },
  );
});

test("labels missed clearly winning positions separately", () => {
  assert.deepEqual(
    classifyPuzzleEligibility({ bestValue: 420, playedValue: 100 }),
    { eligible: true, category: "Missed win", loss: 320 },
  );
});

test("missed mate qualifies even without a large centipawn loss", () => {
  assert.deepEqual(
    classifyPuzzleEligibility({ bestValue: 99800, playedValue: 99720, bestMate: 2, playedMate: null }),
    { eligible: true, category: "Missed mate", loss: 80 },
  );
});

test("keeps a continuing forced mate out of the missed-mate bucket", () => {
  assert.deepEqual(
    classifyPuzzleEligibility({ bestValue: 99800, playedValue: 99720, bestMate: 2, playedMate: 5 }),
    { eligible: false, category: null, loss: 80 },
  );
});
