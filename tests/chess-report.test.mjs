import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Chess } from "../static/vendor/chess/chess.js";
import { buildChessReport, classifyReportMotif } from "../static/lib/chess-report.js";

function reportFixture() {
  const chess = new Chess();
  const frames = [{ fen: chess.fen() }];
  const moves = [];
  for (const uci of ["f2f3", "e7e5", "g2g4"]) {
    const played = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
    moves.push({ ply: moves.length + 1, uci, san: played.san, fen: chess.fen() });
    frames.push({ fen: chess.fen() });
  }
  return {
    imported: { games: [{ id: "report-game", playerColor: "white", opponent: "Fixture", date: "Jul 18, 2026" }] },
    detail: { frames, moves },
  };
}

test("the website exposes only the focused Play, Analysis, and Review routes", async () => {
  const html = await readFile(new URL("../static/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../static/app.js", import.meta.url), "utf8");
  const visibleRoutes = [...html.matchAll(/id="nav(Play|Analysis|Review)"/g)].map(match => match[1]);
  assert.deepEqual(visibleRoutes, ["Play", "Analysis", "Review"]);
  assert.doesNotMatch(html, /id="nav(?:Home|Masters|Report|TacticsReport|About|Training)"/);
  assert.match(html, /id="analysisPage"/);
  assert.match(html, /id="playPage"/);
  assert.match(html, /id="tacticsReportPage"/);
  assert.match(html, /Find the patterns behind your mistakes\./);
  assert.match(html, /id="reviewGameLimit"/);
  assert.match(html, /20 games/);
  assert.match(html, /50 games/);
  assert.match(html, /id="analysisInsights"/);
  assert.match(html, /Practice my positions/);
  assert.match(html, /data-analysis-level="superquick"/);
  assert.match(html, /data-report-game-limit="20"/);
  assert.match(html, /data-report-game-limit="50"/);
  assert.match(app, /analysisLevel: "superquick"/);
  assert.match(app, /reportGameLimit: DEFAULT_REPORT_GAMES/);
  assert.match(app, /reportMode: mode === "tactics" \? "combined" : mode/);
});

test("report counts losses at 80 cp, ignores 79 cp, reports progress, and closes its engine", async () => {
  const { imported, detail } = reportFixture();
  const firstFen = detail.frames[0].fen;
  const secondFen = detail.frames[2].fen;
  const calls = [];
  let closed = false;
  const progress = [];
  const engine = {
    async init() {},
    async evaluate(fen, searchMoves = null) {
      const constrained = Array.isArray(searchMoves) ? searchMoves[0] : searchMoves;
      calls.push({ fen, constrained });
      if (constrained === "f2f3") return { bestmove: "f2f3", depth: 16, cp: -50, mate: null, pv: ["f2f3", "e7e5"] };
      if (constrained === "g2g4") return { bestmove: "g2g4", depth: 16, cp: -29, mate: null, pv: ["g2g4", "d8h4"] };
      if (fen === firstFen) return { bestmove: "e2e4", depth: 12, cp: 30, mate: null, pv: ["e2e4"] };
      if (fen === secondFen) return { bestmove: "d2d4", depth: 12, cp: 50, mate: null, pv: ["d2d4"] };
      throw new Error("Unexpected report position");
    },
    close() { closed = true; },
  };
  const report = await buildChessReport({
    username: "Fixture",
    source: "pgn",
    importedGames: imported,
    gameDetail: () => detail,
    engineFactory: id => {
      assert.equal(id, "stockfish-browser");
      return engine;
    },
    onProgress: value => progress.push(value),
  });
  assert.equal(report.games, 1);
  assert.equal(report.positions, 2);
  assert.equal(report.mistakes, 1);
  assert.equal(report.examples.length, 1);
  assert.equal(report.examples[0].loss, 80);
  assert.equal(calls.length, 4);
  assert.equal(progress.length, 2);
  assert.equal(closed, true);
  assert.equal(report.wrapped.games, 1);
  assert.equal(report.wrapped.moves, 2);
  assert.ok(report.wrapped.averageAccuracy > 80 && report.wrapped.averageAccuracy < 83);
});

test("combined review uses chess_detect tags for Lichess recommendations and own-game puzzles", async () => {
  const chess = new Chess();
  const before = chess.fen();
  const move = chess.move("f3");
  const detail = { frames: [{ fen: before }, { fen: chess.fen() }], moves: [{ ply: 1, uci: `${move.from}${move.to}`, san: move.san, fen: chess.fen() }] };
  const game = { id: "tagged-review", playerColor: "white", opponent: "Fixture", date: "Jul 21, 2026", result: "Loss" };
  const report = await buildChessReport({
    username: "Fixture",
    source: "pgn",
    importedGames: { games: [game] },
    gameDetail: () => detail,
    prepareMotifAnalyzer: async () => true,
    motifAnalyzer: () => ({
      san: "e4",
      tagline: "Forks the king and rook",
      motifIds: ["fork"],
      recommendations: [{ id: "fork", label: "Forks", advice: "Practice forks.", url: "https://lichess.org/training/fork" }],
      analyzer: "chess_detect-ts",
    }),
    engineFactory: () => ({
      async init() {},
      async evaluate(_fen, searchMoves = null) {
        if (searchMoves) return { bestmove: "f2f3", cp: -100, mate: null, pv: ["f2f3"] };
        return { bestmove: "e2e4", cp: 300, mate: null, pv: ["e2e4"] };
      },
      close() {},
    }),
  });
  assert.equal(report.mode, "combined");
  assert.deepEqual(report.recommendations.map(item => [item.id, item.count]), [["fork", 1]]);
  assert.equal(report.examples[0].analyzer, "chess_detect-ts");
  assert.equal(report.puzzles.length, 1);
  assert.equal(report.puzzles[0].positionalTagline, "Forks the king and rook");
  assert.equal(report.puzzles[0].lichessRecommendations[0].url, "https://lichess.org/training/fork");
});

test("report gives an explicit error for an empty imported set", async () => {
  await assert.rejects(buildChessReport({
    username: "Nobody",
    source: "pgn",
    importedGames: { games: [] },
  }), /No standard chess games/);
});

test("report labels a forced mating attack as mate and describes it cleanly", async () => {
  const chess = new Chess();
  chess.move("f3");
  chess.move("e5");
  const fen = chess.fen();
  const played = chess.move("g4");
  const detail = {
    frames: [{ fen }],
    moves: [{ ply: 1, uci: `${played.from}${played.to}`, san: played.san, fen: chess.fen() }],
  };
  const engine = {
    async init() {},
    async evaluate(_fen, searchMoves = null) {
      if (searchMoves) return { bestmove: "g2g4", depth: 12, cp: null, mate: -1, pv: ["g2g4", "d8h4"] };
      return { bestmove: "d2d4", depth: 12, cp: 40, mate: null, pv: ["d2d4"] };
    },
    close() {},
  };
  const report = await buildChessReport({
    username: "Fixture",
    source: "pgn",
    importedGames: { games: [{ id: "mate-game", playerColor: "white", opponent: "Mate", date: "Imported game" }] },
    gameDetail: () => detail,
    engineFactory: () => engine,
  });
  assert.equal(report.examples[0].motif, "mate");
  assert.equal(report.examples[0].consequence, "allowed mate in 1");
});

test("report evaluates only the studied player's moves when that player has Black", async () => {
  const chess = new Chess();
  const frames = [{ fen: chess.fen() }];
  const moves = [];
  for (const uci of ["e2e4", "e7e5", "g1f3", "b8c6"]) {
    const played = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
    moves.push({ ply: moves.length + 1, uci, san: played.san, fen: chess.fen() });
    frames.push({ fen: chess.fen() });
  }
  const expected = new Map([
    [frames[1].fen, "e7e5"],
    [frames[3].fen, "b8c6"],
  ]);
  const calls = [];
  let closed = false;
  const engine = {
    async init() {},
    async evaluate(fen, searchMoves = null) {
      calls.push({ fen, searchMoves });
      const bestmove = expected.get(fen);
      assert.ok(bestmove, `unexpected position ${fen}`);
      return { bestmove, depth: 12, cp: 20, mate: null, pv: [bestmove] };
    },
    close() { closed = true; },
  };
  const report = await buildChessReport({
    username: "Black Fixture",
    source: "pgn",
    importedGames: { games: [{ id: "black-game", playerColor: "black", opponent: "White Fixture", date: "Imported game" }] },
    gameDetail: () => ({ frames, moves }),
    engineFactory: () => engine,
  });
  assert.equal(report.positions, 2);
  assert.equal(report.mistakes, 0);
  assert.deepEqual(calls.map(call => call.fen), [frames[1].fen, frames[3].fen]);
  assert.ok(calls.every(call => call.searchMoves === null));
  assert.equal(closed, true);
});

test("report uses the saved FEN turn for Black-to-move setup positions", async () => {
  const chess = new Chess("2k5/8/8/8/8/n7/8/Q3K3 b - - 0 1");
  const before = chess.fen();
  const played = chess.move({ from: "a3", to: "b5" });
  const detail = {
    frames: [{ fen: before }, { fen: chess.fen() }],
    moves: [{ ply: 1, uci: "a3b5", san: played.san, fen: chess.fen() }],
  };
  let calls = 0;
  const report = await buildChessReport({
    username: "Black setup",
    source: "pgn",
    importedGames: { games: [{ id: "black-setup", playerColor: "black", opponent: "White", date: "Imported game" }] },
    gameDetail: () => detail,
    engineFactory: () => ({
      async init() {},
      async evaluate(_fen, searchMoves = null) {
        calls += 1;
        return searchMoves
          ? { bestmove: "a3b5", depth: 16, cp: -1170, mate: null, pv: ["a3b5"] }
          : { bestmove: "a3c2", depth: 16, cp: -7, mate: null, pv: ["a3c2"] };
      },
      close() {},
    }),
  });
  assert.equal(report.positions, 1);
  assert.equal(report.mistakes, 1);
  assert.equal(report.puzzles.length, 1);
  assert.equal(report.examples[0].analyzer, "chess_detect-ts");
  assert.ok(report.examples[0].motifIds.includes("fork"));
  assert.equal(report.recommendations[0].url, "https://lichess.org/training/fork");
  assert.match(report.puzzles[0].positionalTagline, /Forks/);
  assert.equal(calls, 2);
});

test("report always closes Stockfish when evaluation fails", async () => {
  const { imported, detail } = reportFixture();
  let closed = false;
  const engine = {
    async init() {},
    async evaluate() { throw new Error("engine stopped"); },
    close() { closed = true; },
  };
  await assert.rejects(buildChessReport({
    username: "Fixture",
    source: "pgn",
    importedGames: imported,
    gameDetail: () => detail,
    engineFactory: () => engine,
  }), /engine stopped/);
  assert.equal(closed, true);
});

test("report can be stopped before engine startup", async () => {
  const { imported, detail } = reportFixture();
  const controller = new AbortController();
  controller.abort();
  let closed = false;
  await assert.rejects(buildChessReport({
    username: "Fixture",
    source: "pgn",
    importedGames: imported,
    gameDetail: () => detail,
    signal: controller.signal,
    engineFactory: () => ({ async init() {}, async evaluate() {}, close() { closed = true; } }),
  }), error => error.name === "AbortError");
  assert.equal(closed, true);
});

test("Chess Report returns the Wrapped overview without tactical sections", async () => {
  const { imported, detail } = reportFixture();
  const engine = {
    async init() {},
    async evaluate(_fen, searchMoves = null) {
      if (searchMoves) return { bestmove: Array.isArray(searchMoves) ? searchMoves[0] : searchMoves, depth: 16, cp: -100, mate: null, pv: [] };
      return { bestmove: "e2e4", depth: 16, cp: 100, mate: null, pv: ["e2e4"] };
    },
    close() {},
  };
  const report = await buildChessReport({
    username: "Fixture",
    source: "pgn",
    reportMode: "wrapped",
    importedGames: imported,
    gameDetail: () => detail,
    engineFactory: () => engine,
  });
  assert.equal(report.mode, "wrapped");
  assert.ok(report.wrapped.averageAccuracy < 100);
  assert.equal(report.mistakes, 0);
  assert.deepEqual(report.recommendations, []);
  assert.deepEqual(report.examples, []);
});

test("Tactics Report omits Wrapped statistics and keeps tactical findings", async () => {
  const { imported, detail } = reportFixture();
  const engine = {
    async init() {},
    async evaluate(_fen, searchMoves = null) {
      if (searchMoves) return { bestmove: Array.isArray(searchMoves) ? searchMoves[0] : searchMoves, depth: 16, cp: -100, mate: null, pv: [] };
      return { bestmove: "e2e4", depth: 16, cp: 100, mate: null, pv: ["e2e4"] };
    },
    close() {},
  };
  const report = await buildChessReport({
    username: "Fixture",
    source: "pgn",
    reportMode: "tactics",
    importedGames: imported,
    gameDetail: () => detail,
    engineFactory: () => engine,
  });
  assert.equal(report.mode, "tactics");
  assert.equal(report.wrapped, null);
  assert.equal(report.mistakes, 2);
  assert.equal(report.examples.length, 2);
});

test("reports default to 20 games and can be expanded to 50", async () => {
  const { detail } = reportFixture();
  const firstFen = detail.frames[0].fen;
  const importedGames = {
    games: Array.from({ length: 51 }, (_, index) => ({
      id: `game-${index}`,
      playerColor: "white",
      opponent: `Opponent ${index}`,
      result: index % 2 ? "Win" : "Loss",
    })),
  };
  let detailCalls = 0;
  const defaultReport = await buildChessReport({
    username: "Fixture",
    source: "pgn",
    reportMode: "wrapped",
    importedGames,
    gameDetail: () => { detailCalls += 1; return detail; },
    engineFactory: () => ({
      async init() {},
      async evaluate(fen) { return { bestmove: fen === firstFen ? "f2f3" : "g2g4", depth: 16, cp: 20, mate: null, pv: [] }; },
      close() {},
    }),
  });
  assert.equal(defaultReport.games, 20);
  assert.equal(defaultReport.wrapped.games, 20);
  assert.equal(defaultReport.gameLimit, 20);
  assert.equal(detailCalls, 20);

  detailCalls = 0;
  const expandedReport = await buildChessReport({
    username: "Fixture",
    source: "pgn",
    reportMode: "wrapped",
    gameLimit: 50,
    importedGames,
    gameDetail: () => { detailCalls += 1; return detail; },
    engineFactory: () => ({
      async init() {},
      async evaluate(fen) { return { bestmove: fen === firstFen ? "f2f3" : "g2g4", depth: 16, cp: 20, mate: null, pv: [] }; },
      close() {},
    }),
  });
  assert.equal(expandedReport.games, 50);
  assert.equal(expandedReport.wrapped.games, 50);
  assert.equal(expandedReport.gameLimit, 50);
  assert.equal(detailCalls, 50);

  detailCalls = 0;
  const tacticsReport = await buildChessReport({
    username: "Fixture",
    source: "pgn",
    reportMode: "tactics",
    gameLimit: 35,
    importedGames,
    gameDetail: () => { detailCalls += 1; return detail; },
    engineFactory: () => ({
      async init() {},
      async evaluate(fen) { return { bestmove: fen === firstFen ? "f2f3" : "g2g4", depth: 16, cp: 20, mate: null, pv: [] }; },
      close() {},
    }),
  });
  assert.equal(tacticsReport.games, 35);
  assert.equal(tacticsReport.gameLimit, 35);
  assert.equal(tacticsReport.wrapped, null);
  assert.equal(detailCalls, 35);
});

test("report flips a constrained result before classifying the opponent's reply", () => {
  const fen = new Chess().fen();
  const motif = classifyReportMotif({
    fen,
    best: { bestmove: "e2e4", cp: 20, mate: null, pv: ["e2e4"] },
    playedUci: "f2f3",
    played: { bestmove: "f2f3", cp: null, mate: -3, pv: ["f2f3", "e7e5"] },
    loss: 99_700,
  });
  assert.equal(motif, "mate");
});
