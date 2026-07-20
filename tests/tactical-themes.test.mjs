import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "../static/vendor/chess/chess.js";
import { classifyReportThemes } from "../static/lib/chess-report.js";
import { classifyTacticalLine } from "../static/lib/tactical-themes.js";

test("classifies a forced mate from the engine result", () => {
  const chess = new Chess();
  chess.move("f3");
  chess.move("e5");
  chess.move("g4");
  const result = classifyTacticalLine({
    fen: chess.fen(),
    moves: ["d8h4"],
    result: { bestmove: "d8h4", cp: null, mate: 1, pv: ["d8h4"] },
  });
  assert.equal(result.primary, "mate");
});

test("distinguishes promotion and underpromotion", () => {
  const fen = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
  assert.equal(classifyTacticalLine({ fen, moves: ["a7a8q"] }).primary, "promotion");
  assert.equal(classifyTacticalLine({ fen, moves: ["a7a8n"] }).primary, "underPromotion");
});

test("recognizes an immediate knight fork of king and rook", () => {
  const result = classifyTacticalLine({
    fen: "3k3r/8/8/4N3/8/8/8/4K3 w - - 0 1",
    moves: ["e5f7", "d8e7", "f7h8"],
  });
  assert.equal(result.primary, "fork");
});

test("uses calculation when no high-confidence motif is present", () => {
  assert.equal(classifyTacticalLine({ fen: new Chess().fen(), moves: ["e2e4"] }).primary, "calculation");
});

test("report naming ignores motifs that occur only during later conversion", () => {
  const classification = classifyReportThemes({
    fen: "4k3/8/8/8/1p6/8/8/4K3 w - - 0 1",
    best: { bestmove: "e1f1", cp: 0, mate: null, pv: ["e1f1"] },
    playedUci: "e1d1",
    played: {
      bestmove: "e1d1",
      cp: -500,
      mate: null,
      pv: ["e1d1", "b4b3", "d1c1", "b3b2", "c1d1", "b2b1q"],
    },
  });
  assert.equal(classification.primary, "calculation");
  assert.ok(!classification.themes.includes("promotion"));
});
