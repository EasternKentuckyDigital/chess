import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeSacrificeLine,
  findSacrificeCandidate,
  isSoundBrilliancy,
} from "../static/lib/brilliancy.js";

test("detects a direct bishop sacrifice", () => {
  const candidate = findSacrificeCandidate("6k1/7p/8/8/8/3B4/8/6K1 w - - 0 1", "d3h7");
  assert.equal(candidate?.playedSan, "Bxh7+");
  assert.equal(candidate?.pieceName, "bishop");
  assert.equal(candidate?.investment, 230);
  assert.equal(candidate?.movedPiece, true);
});

test("detects an exchange-style rook offer", () => {
  const fen = "4k3/4p3/8/8/8/8/4R3/4K3 w - - 0 1";
  const candidate = findSacrificeCandidate(fen, "e2e7");
  assert.equal(candidate?.investment, 400);
  const line = analyzeSacrificeLine(fen, ["e2e7", "e8e7"], "w");
  assert.equal(line.investment, 400);
  assert.equal(line.san, "Rxe7+ Kxe7");
});

test("detects a discovered sacrifice", () => {
  const candidate = findSacrificeCandidate("4k3/8/b7/8/8/3N4/4R3/4K3 w - - 0 1", "d3b4");
  assert.equal(candidate?.pieceName, "rook");
  assert.equal(candidate?.investment, 500);
  assert.equal(candidate?.movedPiece, false);
  assert.equal(candidate?.wasAlreadyOffered, false);
});

test("keeps zwischenzug offers eligible for engine validation", () => {
  const candidate = findSacrificeCandidate("4k3/8/b7/8/8/8/4R3/1N2K3 w - - 0 1", "b1c3");
  assert.equal(candidate?.pieceName, "rook");
  assert.equal(candidate?.wasAlreadyOffered, true);
});

test("requires a sound, competitive engine result", () => {
  assert.equal(isSoundBrilliancy({ loss: 42, playedValue: 75, alternativeValue: -30, pieceCount: 22 }), true);
  assert.equal(isSoundBrilliancy({ loss: 160, playedValue: -180, alternativeValue: 20, pieceCount: 22 }), false);
  assert.equal(isSoundBrilliancy({ loss: 20, playedValue: 1020, alternativeValue: 980, pieceCount: 22 }), false);
  assert.equal(isSoundBrilliancy({ loss: 10, playedValue: 60, alternativeValue: 20, pieceCount: 8 }), false);
  assert.equal(isSoundBrilliancy({ loss: 10, playedValue: 120, alternativeValue: 20, pieceCount: 8 }), true);
});
