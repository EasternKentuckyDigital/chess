import assert from "node:assert/strict";
import test from "node:test";
import { createOddsPosition, PLAY_ODDS } from "../static/lib/engine-play.js";

test("publishes standard and both sides of knight, rook, and queen odds", () => {
  assert.deepEqual(PLAY_ODDS.map(preset => preset.id), [
    "standard",
    "engine-knight",
    "engine-rook",
    "engine-queen",
    "human-knight",
    "human-rook",
    "human-queen",
  ]);
});

test("engine odds remove the engine's requested piece for either human color", () => {
  const whiteHuman = createOddsPosition({ humanColor: "w", odds: "engine-queen" });
  assert.equal(whiteHuman.get("d8"), undefined);
  assert.equal(whiteHuman.get("d1").type, "q");

  const blackHuman = createOddsPosition({ humanColor: "b", odds: "engine-knight" });
  assert.equal(blackHuman.get("b1"), undefined);
  assert.equal(blackHuman.get("b8").type, "n");
});

test("human odds remove the human piece and keep rook-odds castling legal", () => {
  const rookOdds = createOddsPosition({ humanColor: "b", odds: "human-rook" });
  assert.equal(rookOdds.get("a8"), undefined);
  assert.deepEqual(rookOdds.getCastlingRights("b"), { k: true, q: false });

  const queenOdds = createOddsPosition({ humanColor: "w", odds: "human-queen" });
  assert.equal(queenOdds.get("d1"), undefined);
  assert.equal(queenOdds.get("d8").type, "q");
});
