import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildChessReport } from "../static/lib/chess-report.js";
import { getGameDetail, importPgnText } from "../static/lib/game-import.js";

const STOCKFISH_SCRIPT = fileURLToPath(new URL("../static/vendor/stockfish/stockfish-18-lite-single.js", import.meta.url));

class StockfishProcess {
  constructor() {
    this.child = spawn(process.execPath, [STOCKFISH_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    this.buffer = "";
    this.waiters = [];
    this.pending = null;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => this.consume(chunk));
    this.child.on("error", error => this.fail(error));
    this.child.on("exit", code => {
      if (code && this.pending) this.fail(new Error(`Stockfish exited with code ${code}.`));
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines.map(value => value.trim()).filter(Boolean)) this.onLine(line);
  }

  onLine(line) {
    const waiter = this.waiters.find(item => line.includes(item.token));
    if (waiter) {
      this.waiters = this.waiters.filter(item => item !== waiter);
      waiter.resolve(line);
    }
    if (!this.pending) return;
    if (line.startsWith("info ") && line.includes(" score ")) {
      const fields = line.split(/\s+/);
      const depth = Number(fields[fields.indexOf("depth") + 1]) || 0;
      const scoreIndex = fields.indexOf("score");
      const type = fields[scoreIndex + 1];
      const value = Number(fields[scoreIndex + 2]);
      const pvIndex = fields.indexOf("pv");
      if (depth >= this.pending.result.depth) this.pending.result = {
        depth,
        cp: type === "cp" ? value : null,
        mate: type === "mate" ? value : null,
        pv: pvIndex >= 0 ? fields.slice(pvIndex + 1) : [],
      };
    }
    if (line.startsWith("bestmove ")) {
      const pending = this.pending;
      this.pending = null;
      pending.resolve({ ...pending.result, bestmove: line.split(/\s+/)[1] });
    }
  }

  fail(error) {
    if (this.pending) {
      this.pending.reject(error);
      this.pending = null;
    }
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters = [];
  }

  waitFor(token) {
    return new Promise((resolve, reject) => this.waiters.push({ token, resolve, reject }));
  }

  async init() {
    const uci = this.waitFor("uciok");
    this.child.stdin.write("uci\n");
    await uci;
    this.child.stdin.write("setoption name Hash value 32\n");
    const ready = this.waitFor("readyok");
    this.child.stdin.write("isready\n");
    await ready;
  }

  evaluate(fen, searchMoves = null) {
    if (this.pending) return Promise.reject(new Error("Stockfish received overlapping searches."));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, result: { depth: 0, cp: 0, mate: null, pv: [] } };
      this.child.stdin.write(`position fen ${fen}\n`);
      const moves = Array.isArray(searchMoves) ? searchMoves.join(" ") : searchMoves;
      this.child.stdin.write(`go depth 16${moves ? ` searchmoves ${moves}` : ""}\n`);
    });
  }

  close() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.write("quit\n");
    this.child.kill();
  }
}

const CONTROLLED_PGN = `[Event "Allowed mate"]
[White "Stress Tester"]
[Black "Mate Opponent"]
[Result "0-1"]

1. f3 e5 2. g4 Qh4# 0-1

[Event "Hanging queen"]
[White "Stress Tester"]
[Black "Queen Opponent"]
[Result "0-1"]

1. e4 e5 2. Qh5 Nc6 3. Qxe5+ Nxe5 0-1

[Event "Quiet white control"]
[White "Stress Tester"]
[Black "Quiet White"]
[Result "1/2-1/2"]

1. d4 d5 2. c4 e6 3. Nc3 Nf6 1/2-1/2

[Event "Allowed scholar mate"]
[White "Scholar Opponent"]
[Black "Stress Tester"]
[Result "1-0"]

1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0

[Event "Quiet black control"]
[White "Quiet Black"]
[Black "Stress Tester"]
[Result "1/2-1/2"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 1/2-1/2`;

test("real Stockfish report finds planted mistakes on both colors without flagging quiet controls", async () => {
  const imported = await importPgnText({ text: CONTROLLED_PGN, playerName: "Stress Tester" });
  const report = await buildChessReport({
    username: "Stress Tester",
    source: "pgn",
    importedGames: imported,
    gameDetail: getGameDetail,
    engineFactory: () => new StockfishProcess(),
  });
  const opponents = new Set(report.examples.map(example => example.opponent));
  assert.equal(report.games, 5);
  assert.equal(report.positions, 14);
  assert.equal(report.mistakes, 4, JSON.stringify(report.examples, null, 2));
  assert.ok(opponents.has("Mate Opponent"), "the report should find Fool's Mate");
  assert.ok(opponents.has("Queen Opponent"), "the report should find the hanging queen");
  assert.ok(opponents.has("Scholar Opponent"), "the report should find Black allowing Scholar's Mate");
  assert.equal(opponents.has("Quiet White"), false, "the quiet White control should not be flagged");
  assert.equal(opponents.has("Quiet Black"), false, "the quiet Black control should not be flagged");
  assert.ok(report.examples.some(example => example.playedMove === "f2f3" && example.motif === "calculation"));
  assert.ok(report.examples.filter(example => example.consequence === "allowed mate in 1").length >= 2);
});

test("real Stockfish depth 16 solves forcing tactical and promotion positions", async () => {
  const engine = new StockfishProcess();
  await engine.init();
  try {
    const cases = [
      ["mate in one", "4r1k1/pp3ppp/2p5/8/8/2P2Q2/PP3PPP/4R1K1 w - - 0 1", "e1e8"],
      ["capture an exposed queen", "4k3/8/8/8/4q3/8/4R3/4K3 w - - 0 1", "e2e4"],
      ["use en passant", "rnbqkbnr/pppp1ppp/8/4pP2/8/8/PPPPP1PP/RNBQKBNR w KQkq e6 0 2", "f5e6"],
      ["promote the passed pawn", "7k/P7/8/8/8/8/8/4K3 w - - 0 1", "a7a8q"],
    ];
    for (const [name, fen, expected] of cases) {
      const result = await engine.evaluate(fen);
      assert.equal(result.bestmove, expected, `Stockfish should ${name}`);
      assert.equal(result.depth, 16);
    }
  } finally {
    engine.close();
  }
});
