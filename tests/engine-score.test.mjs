import assert from "node:assert/strict";
import test from "node:test";
import {
  centipawnLoss,
  lichessCentipawnsToSideToMove,
  oppositeSideResult,
  sideToMoveScore,
  whitePerspectiveScore,
} from "../static/lib/engine-score.js";

const WHITE_TO_MOVE = "8/8/8/8/8/8/4K3/7k w - - 0 1";
const BLACK_TO_MOVE = "8/8/8/8/8/8/4K3/7k b - - 0 1";

test("UCI scores are sortable from the side-to-move perspective", () => {
  assert.equal(sideToMoveScore({ cp: 125, mate: null }), 125);
  assert.equal(sideToMoveScore({ cp: -80, mate: null }), -80);
  assert.ok(sideToMoveScore({ cp: null, mate: 2 }) > sideToMoveScore({ cp: 50_000, mate: null }));
  assert.ok(sideToMoveScore({ cp: null, mate: -5 }) < sideToMoveScore({ cp: -50_000, mate: null }));
  assert.ok(sideToMoveScore({ cp: null, mate: 2 }) > sideToMoveScore({ cp: null, mate: 4 }));
});

test("advancing a constrained PV one ply flips both centipawn and mate perspective", () => {
  assert.deepEqual(
    oppositeSideResult({ bestmove: "f2f3", cp: -720, mate: null, pv: ["f2f3", "e7e5"] }),
    { bestmove: "f2f3", cp: 720, mate: null, pv: ["f2f3", "e7e5"] },
  );
  assert.equal(oppositeSideResult({ cp: null, mate: -3 }).mate, 3);
});

test("White-perspective display and Lichess conversion flip only for Black to move", () => {
  const engineResult = { cp: 140, mate: null };
  assert.equal(whitePerspectiveScore(engineResult, WHITE_TO_MOVE), 140);
  assert.equal(whitePerspectiveScore(engineResult, BLACK_TO_MOVE), -140);
  assert.equal(lichessCentipawnsToSideToMove(140, WHITE_TO_MOVE), 140);
  assert.equal(lichessCentipawnsToSideToMove(140, BLACK_TO_MOVE), -140);
});

test("move loss compares same-position UCI scores without a color-dependent sign flip", () => {
  const best = { cp: 120, mate: null };
  const played = { cp: -80, mate: null };
  assert.equal(centipawnLoss(best, played), 200);
  assert.equal(centipawnLoss(played, best), 0);
});
