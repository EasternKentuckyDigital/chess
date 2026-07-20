import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "../static/vendor/chess/chess.js";
import { PROMOTION_CHOICES, normalizePromotion, selectPromotionMove } from "../static/lib/promotion.js";

const PROMOTION_FEN = "7k/P7/8/8/8/8/8/4K3 w - - 0 1";

test("offers every legal promotion piece with queen as the default", () => {
  assert.deepEqual(PROMOTION_CHOICES.map(choice => choice.value), ["q", "r", "b", "n"]);
  assert.equal(normalizePromotion("bad-value"), "q");
  const chess = new Chess(PROMOTION_FEN);
  const moves = chess.moves({ square: "a7", verbose: true });
  for (const promotion of ["q", "r", "b", "n"]) {
    assert.equal(selectPromotionMove(moves, "a8", promotion).promotion, promotion);
  }
  assert.equal(selectPromotionMove(moves, "a8").promotion, "q");
});

test("promotion selection leaves ordinary legal moves unchanged", () => {
  const chess = new Chess();
  const move = selectPromotionMove(chess.moves({ square: "e2", verbose: true }), "e4", "n");
  assert.equal(move.san, "e4");
  assert.equal(move.promotion, undefined);
});
