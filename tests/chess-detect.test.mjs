import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  CHESS_DETECT_COMMIT,
  aggregateRecommendations,
  classifyTactic,
  composeTacticTagline,
  recommendationsForThemes,
} from "../static/lib/chess-detect.js";

const upstreamCases = [
  ["fork", "q3k3/8/8/1N6/8/8/8/4K3 w - - 0 1", "b5c7"],
  ["double_check", "3k4/8/8/8/3N4/8/8/3RK3 w - - 0 1", "d4c6"],
  ["discovered_check", "3k4/8/4p3/8/3N4/8/8/3RK3 w - - 0 1", "d4e6"],
  ["pin", "6k1/8/4n3/8/8/1B6/8/4K3 w - - 0 1", "b3c4"],
  ["skewer", "4q3/8/8/4k3/8/8/8/R5K1 w - - 0 1", "a1e1"],
  ["trapped_piece", "4k2n/4P3/5R2/5BP1/8/8/8/4K2Q w - - 0 1", "g5g6"],
  ["hanging_capture", "4k3/8/8/R3n3/8/8/8/4K3 w - - 0 1", "a5e5"],
  ["removing_defender_material", "4k3/8/8/8/4b3/Q1n5/8/1B2K3 w - - 0 1", "a3c3"],
  ["removing_defender_mate", "7k/6p1/6r1/8/4B3/2Q5/8/4K3 w - - 0 1", "e4g6"],
  ["exploiting_pin", "4k3/8/8/5p2/4n3/8/3P4/4R1K1 w - - 0 1", "d2d3"],
];

test("TypeScript port covers all ten chess_detect tactical detectors", () => {
  assert.equal(CHESS_DETECT_COMMIT, "662ad8d64f59a4bbc83cc003585f9bf10f4b7a70");
  for (const [expected, fen, move] of upstreamCases) {
    const result = classifyTactic(fen, move);
    assert.ok(result, `${expected} should classify`);
    assert.ok(result.themeIds.includes(expected), `${move} should include ${expected}; got ${result.themeIds}`);
    assert.equal(result.analyzer, "chess_detect-ts");
    assert.deepEqual(result.motifIds, result.themeIds);
  }
});

test("upstream negative cases stay unclassified for the named false motif", () => {
  const negatives = [
    ["fork", "4k3/1p6/p7/8/8/2N5/8/4K3 w - - 0 1", "c3b5"],
    ["double_check", "3k4/8/8/8/8/8/8/3RK3 w - - 0 1", "d1d7"],
    ["pin", "6k1/8/4n3/3P4/8/1B6/8/4K3 w - - 0 1", "b3c4"],
    ["skewer", "4k3/8/8/p7/1nb5/8/8/R3K3 w - - 0 1", "a1a4"],
    ["removing_defender_material", "4k3/8/5n2/8/4b3/Q1n5/8/1B2K3 w - - 0 1", "a3c3"],
    ["removing_defender_mate", "2r4r/1pP1kpp1/3p4/3Pp3/4P3/3P1NPq/4n1QP/2R2R1K b - - 6 30", "h3g2"],
    ["exploiting_pin", "6k1/8/4n3/8/8/1B6/8/4K3 w - - 0 1", "b3c4"],
  ];
  for (const [unexpected, fen, move] of negatives) {
    const result = classifyTactic(fen, move);
    assert.ok(!result?.themeIds.includes(unexpected), `${move} must not include ${unexpected}; got ${result?.themeIds}`);
  }
});

test("an immediate recapture is not mislabeled as a hanging-piece win", () => {
  const result = classifyTactic(
    "4k3/8/3p4/4n3/8/5N2/8/4K3 w - - 0 1",
    "f3e5",
    { previousMove: { from: "d6", to: "e5", wasCapture: true } },
  );
  assert.ok(!result?.themeIds.includes("hanging_capture"));
});

test("invalid FENs and illegal or malformed moves fail closed", () => {
  assert.equal(classifyTactic("not-a-fen", "e2e4"), null);
  assert.equal(classifyTactic("4k3/8/8/8/8/8/8/4K3 w - - 0 1", "e2e4"), null);
  assert.equal(classifyTactic("4k3/8/8/8/8/8/8/4K3 w - - 0 1", "e2-e4"), null);
});

test("detected themes map only to valid tagged Lichess routes", () => {
  const recommendations = recommendationsForThemes(["fork", "discovered_check", "removing_defender_material", "fork"]);
  assert.deepEqual(recommendations.map(item => item.id), ["fork", "discoveredCheck", "capturingDefender"]);
  assert.ok(recommendations.every(item => item.url === `https://lichess.org/training/${item.id}`));
  assert.deepEqual(recommendationsForThemes(["check", "king_pressure", "unknown"]), []);
});

test("theme copy and batch ranking are stable", () => {
  assert.equal(composeTacticTagline([
    { id: "pin", phrase: "Pins the knight", label: "Pin", priority: 4, targets: [] },
    { id: "fork", phrase: "Forks the king and queen", label: "Fork", priority: 2, targets: [] },
  ]), "Forks the king and queen");
  assert.equal(composeTacticTagline([]), "Concrete best move");
  const fork = recommendationsForThemes(["fork"])[0];
  const pin = recommendationsForThemes(["pin"])[0];
  const ranked = aggregateRecommendations([
    { loss: 300, recommendations: [pin] },
    { loss: 100, recommendations: [fork] },
    { loss: 500, recommendations: [fork] },
  ]);
  assert.deepEqual(ranked.map(item => [item.id, item.count]), [["fork", 2], ["pin", 1]]);
  assert.equal(ranked[0].impact, 600);
});

test("classifier remains fast enough for a 50-game browser review", () => {
  const started = performance.now();
  for (let repetition = 0; repetition < 100; repetition += 1) {
    for (const [, fen, move] of upstreamCases) classifyTactic(fen, move);
  }
  const elapsed = performance.now() - started;
  // Node's test runner executes this beside the real Stockfish and Reckless
  // stress suites in CI. Keep a hard 10 ms/classification ceiling without
  // turning shared-runner CPU contention into a deployment failure.
  assert.ok(elapsed < 10_000, `1,000 classifications took ${elapsed.toFixed(1)} ms`);
});
