import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "../static/vendor/chess/chess.js";
import {
  canonicalUci,
  parseArguments,
  parseCsvLine,
  parsePuzzleRecord,
  selectLichessEvaluation,
} from "../scripts/benchmark-lichess.mjs";

test("benchmark arguments default to launch-equivalent engine limits", () => {
  const options = parseArguments(["--eval", "eval.zst", "--puzzles", "puzzles.zst"]);
  assert.equal(options.evalLimit, 1_000);
  assert.equal(options.puzzleLimit, 1_000);
  assert.equal(options.reportLimit, 1_000);
  assert.equal(options.stockfishDepth, 16);
  assert.equal(options.recklessNodes, 400_000);
  assert.deepEqual(options.engines, ["stockfish", "reckless"]);
});

test("benchmark can run the Tactics Report phase without repeating engine cohorts", () => {
  const options = parseArguments(["--eval", "eval.zst", "--puzzles", "puzzles.zst", "--engines", "none"]);
  assert.deepEqual(options.engines, []);
  assert.equal(options.reportLimit, 1_000);
});

test("CSV parser preserves quoted commas and escaped quotes", () => {
  assert.deepEqual(parseCsvLine('a,"b,c","d""e"'), ["a", "b,c", 'd"e']);
});

test("evaluation selector follows Lichess's highest-depth one-PV guidance", () => {
  const reference = selectLichessEvaluation({ evals: [
    { depth: 31, knodes: 90, pvs: [{ cp: 40, line: "a2a4 a7a5" }, { cp: 35, line: "b2b4" }] },
    { depth: 36, knodes: 200, pvs: [{ cp: 51, line: "e2e4 e7e5" }] },
  ] });
  assert.equal(reference.primaryMove, "e2e4");
  assert.equal(reference.depth, 36);
  assert.deepEqual(reference.alternatives.map(item => item.move), ["a2a4", "b2b4"]);
});

test("Lichess puzzle FEN is advanced by the setup move and solution starts at move two", () => {
  const line = "00sHx,q3k1nr/1pp1nQpp/3p4/1P2p3/4P3/B1PP1b2/B5PP/5K2 b k - 0 17,e8d7 a2e6 d7d8 f7f8,1760,80,83,72,mate mateIn2 middlegame short,https://lichess.org/yyznGmXs/black#34,Italian_Game";
  const puzzle = parsePuzzleRecord(line);
  assert.equal(puzzle.setupMove, "e8d7");
  assert.equal(puzzle.solution, "a2e6");
  assert.equal(new Chess(puzzle.puzzleFen).turn(), "w");
  assert.ok(puzzle.themes.includes("mateIn2"));
});

test("canonical UCI accepts ordinary moves and rejects illegal moves", () => {
  const fen = new Chess().fen();
  assert.equal(canonicalUci(fen, "e2e4"), "e2e4");
  assert.equal(canonicalUci(fen, "e2e5"), null);
});
