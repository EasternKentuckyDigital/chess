import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import init, { Engine } from "../static/vendor/reckless/reckless.js";
import { parseInfoLine } from "../static/vendor/reckless/reckless-worker.js";
import { Chess } from "../static/vendor/chess/chess.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const SUPPLIED_FEN = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
async function loadEngine() {
  const parts = await Promise.all(
    [0, 1, 2, 3].map((part) => readFile(new URL(`../static/vendor/reckless/reckless_bg.wasm.part${part}`, import.meta.url))),
  );
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  await init({ module_or_path: bytes });
  const engine = new Engine();
  engine.set_threads(1);
  return engine;
}

test("the pinned Reckless WASM stress suite handles legal moves, search constraints, MultiPV, and varied positions", async () => {
  const engine = await loadEngine();
  assert.equal(engine.fen(), START_FEN);

  engine.set_position(SUPPLIED_FEN);
  assert.equal(engine.fen(), SUPPLIED_FEN);
  engine.set_position(START_FEN);

  const beforeIllegal = engine.fen();
  engine.make_move("e2e5");
  assert.equal(engine.fen(), beforeIllegal, "illegal moves must not change the position");
  engine.make_move("e2e4");
  assert.notEqual(engine.fen(), START_FEN, "legal moves must change the position");

  const firstLines = [];
  engine.go_movetime(30, 2, (line) => {
    const parsed = parseInfoLine(line);
    if (parsed) firstLines.push(parsed);
  });
  const firstBestMove = engine.last_bestmove();
  assert.match(firstBestMove, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
  assert.ok(firstLines.length > 0, "search should emit info output");
  assert.ok(firstLines.some((line) => line.multiPv === 2), "search should emit a second PV");

  const secondLines = [];
  engine.go_uci(6, 0, 1, (line) => secondLines.push(line));
  assert.ok(secondLines.some((line) => line.startsWith("info depth")));
  assert.match(engine.last_bestmove(), /^[a-h][1-8][a-h][1-8][qrbn]?$/);

  const constrainedLines = [];
  engine.set_position(START_FEN);
  engine.go_uci_searchmoves(6, 0, 1, "a2a3", (line) => constrainedLines.push(line));
  assert.ok(constrainedLines.some((line) => line.startsWith("info depth")));
  assert.equal(engine.last_bestmove(), "a2a3");

  const positions = [
    START_FEN,
    SUPPLIED_FEN,
    "r3k2r/p1ppqpb1/bn2pnp1/2pP4/1p2P3/2N2N2/PPQBBPPP/R3K2R w KQkq - 0 1",
    "rnbqkbnr/pppp1ppp/8/4pP2/8/8/PPPPP1PP/RNBQKBNR w KQkq e6 0 2",
    "6k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1",
    "8/5pk1/6p1/3pP3/3P1P2/5K2/8/8 w - - 0 1",
    "4r1k1/pp3ppp/2p5/8/8/2P2Q2/PP3PPP/4R1K1 w - - 0 1",
    "7k/P7/8/8/8/8/8/4K3 w - - 0 1",
  ];
  for (const fen of positions) {
    const chess = new Chess(fen);
    engine.set_position(fen);
    engine.go_movetime(20, 1, () => {});
    const bestmove = engine.last_bestmove();
    assert.match(bestmove, /^[a-h][1-8][a-h][1-8][qrbn]?$/, `invalid move format for ${fen}`);
    const legal = chess.moves({ verbose: true }).some(move => `${move.from}${move.to}${move.promotion || ""}` === bestmove);
    assert.equal(legal, true, `Reckless returned illegal ${bestmove} for ${fen}`);
  }

  const strengthCases = [
    {
      name: "mate in one",
      fen: "4r1k1/pp3ppp/2p5/8/8/2P2Q2/PP3PPP/4R1K1 w - - 0 1",
      expected: "e1e8",
    },
    {
      name: "win an exposed queen",
      fen: "4k3/8/8/8/4q3/8/4R3/4K3 w - - 0 1",
      expected: "e2e4",
    },
    {
      name: "use the en-passant opportunity",
      fen: "rnbqkbnr/pppp1ppp/8/4pP2/8/8/PPPPP1PP/RNBQKBNR w KQkq e6 0 2",
      expected: "f5e6",
    },
    {
      name: "promote the winning passed pawn",
      fen: "7k/P7/7K/8/8/8/8/8 w - - 0 1",
      expected: "a7a8q",
    },
  ];
  for (const { name, fen, expected, expectedMate } of strengthCases) {
    engine.set_position(fen);
    let result = null;
    engine.go_uci(0, 400_000, 1, (line) => {
      const parsed = parseInfoLine(line);
      if (parsed?.multiPv === 1) result = parsed;
    });
    if (expected) assert.equal(engine.last_bestmove(), expected, `Reckless should ${name}`);
    if (expectedMate) assert.ok(result?.mate > 0, `Reckless should ${name}`);
  }
  engine.free();
});
