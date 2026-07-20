#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Chess } from "../static/vendor/chess/chess.js";
import initReckless, { Engine as RecklessWasmEngine } from "../static/vendor/reckless/reckless.js";
import { parseInfoLine } from "../static/vendor/reckless/reckless-worker.js";
import { centipawnLoss, lichessCentipawnsToSideToMove, sideToMoveScore, whitePerspectiveScore } from "../static/lib/engine-score.js";
import { classifyReportThemes, classifySolutionThemes, MIN_REPORT_LOSS } from "../static/lib/chess-report.js";
import { TACTICAL_SPECIFIC_THEMES } from "../static/lib/tactical-themes.js";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const STOCKFISH_SCRIPT = resolve(REPOSITORY_ROOT, "static/vendor/stockfish/stockfish-18-lite-single.js");
const RECKLESS_DIRECTORY = resolve(REPOSITORY_ROOT, "static/vendor/reckless");
const DEFAULTS = Object.freeze({
  evalLimit: 1_000,
  puzzleLimit: 1_000,
  reportLimit: 1_000,
  stockfishDepth: 16,
  recklessNodes: 400_000,
  evalOffset: 0,
  puzzleOffset: 0,
  engines: ["stockfish", "reckless"],
});

function usage() {
  return `Usage:
  node scripts/benchmark-lichess.mjs \\
    --eval /path/to/lichess_db_eval.jsonl.zst \\
    --puzzles /path/to/lichess_db_puzzle.csv.zst \\
    [--eval-limit 1000] [--puzzle-limit 1000] [--report-limit 1000] \\
    [--eval-offset 0] [--puzzle-offset 0] \\
    [--engines stockfish,reckless|none] [--stockfish-depth 16] \\
    [--reckless-nodes 400000] [--output /path/to/results.json]

The inputs may be complete official Lichess exports or leading byte-range
samples. Cohorts are deterministic and balanced between White and Black to move.
The report benchmark uses the puzzle's first move as the real-game tactical
mistake and the second move as Lichess's only-move solution.`;
}

export function parseArguments(argv) {
  const options = { ...DEFAULTS, engines: [...DEFAULTS.engines], eval: null, puzzles: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") return { ...options, help: true };
    const value = argv[++index];
    if (!value) throw new Error(`${key} requires a value.`);
    if (key === "--eval") options.eval = resolve(value);
    else if (key === "--puzzles") options.puzzles = resolve(value);
    else if (key === "--output") options.output = resolve(value);
    else if (key === "--eval-limit") options.evalLimit = positiveInteger(value, key);
    else if (key === "--puzzle-limit") options.puzzleLimit = positiveInteger(value, key);
    else if (key === "--report-limit") options.reportLimit = positiveInteger(value, key, true);
    else if (key === "--eval-offset") options.evalOffset = positiveInteger(value, key, true);
    else if (key === "--puzzle-offset") options.puzzleOffset = positiveInteger(value, key, true);
    else if (key === "--stockfish-depth") options.stockfishDepth = positiveInteger(value, key);
    else if (key === "--reckless-nodes") options.recklessNodes = positiveInteger(value, key);
    else if (key === "--engines") options.engines = value === "none" ? [] : value.split(",").map(item => item.trim()).filter(Boolean);
    else throw new Error(`Unknown option: ${key}`);
  }
  const invalidEngine = options.engines.find(engine => !["stockfish", "reckless"].includes(engine));
  if (invalidEngine) throw new Error(`Unknown engine: ${invalidEngine}`);
  return options;
}

function positiveInteger(value, key, allowZero = false) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1)) throw new Error(`${key} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  return number;
}

function withFenCounters(fen) {
  const fields = String(fen || "").trim().split(/\s+/);
  if (fields.length === 4) return `${fields.join(" ")} 0 1`;
  if (fields.length === 6) return fields.join(" ");
  throw new Error(`Invalid FEN field count: ${fen}`);
}

export function parseCsvLine(line) {
  const fields = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(value);
      value = "";
    } else value += char;
  }
  fields.push(value);
  return fields;
}

export function selectLichessEvaluation(record) {
  const evaluations = (record?.evals || []).filter(item => item?.pvs?.length);
  if (!evaluations.length) return null;
  const deepest = evaluations.reduce((best, item) => !best || Number(item.depth) > Number(best.depth) ? item : best, null);
  const widest = evaluations.reduce((best, item) => !best || item.pvs.length > best.pvs.length ? item : best, null);
  const primary = deepest.pvs[0];
  const primaryMove = String(primary?.line || "").split(/\s+/)[0];
  if (!primaryMove) return null;
  return {
    depth: Number(deepest.depth) || 0,
    knodes: Number(deepest.knodes) || 0,
    primary,
    primaryMove,
    alternatives: widest.pvs.map(pv => ({ ...pv, move: String(pv.line || "").split(/\s+/)[0] })).filter(pv => pv.move),
  };
}

function inputLines(path) {
  let process = null;
  let input;
  if (extname(path) === ".zst") {
    process = spawn("zstd", ["-dc", path], { stdio: ["ignore", "pipe", "ignore"] });
    input = process.stdout;
  } else input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  return {
    lines,
    close() {
      lines.close();
      input.destroy?.();
      if (process && process.exitCode === null) process.kill("SIGTERM");
    },
  };
}

function balancedQuota(limit) {
  return { w: Math.ceil(limit / 2), b: Math.floor(limit / 2) };
}

export async function loadEvaluationCohort(path, limit, offset = 0) {
  const reader = inputLines(path);
  const quota = balancedQuota(limit);
  const counts = { w: 0, b: 0 };
  const records = [];
  const seen = new Set();
  let skipped = 0;
  try {
    for await (const line of reader.lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); }
      catch { continue; }
      let fen;
      try { fen = withFenCounters(record.fen); }
      catch { continue; }
      const side = fen.split(" ")[1];
      if (!quota[side] || counts[side] >= quota[side] || seen.has(fen)) continue;
      const reference = selectLichessEvaluation(record);
      if (!reference) continue;
      try { new Chess(fen); }
      catch { continue; }
      if (skipped < offset) {
        skipped += 1;
        continue;
      }
      records.push({ fen, side, reference });
      counts[side] += 1;
      seen.add(fen);
      if (records.length >= limit) break;
    }
  } finally { reader.close(); }
  if (records.length < limit) throw new Error(`Only found ${records.length} usable balanced evaluation positions; requested ${limit}.`);
  return records;
}

export function parsePuzzleRecord(line) {
  const fields = parseCsvLine(line);
  if (fields[0] === "PuzzleId" || fields.length < 9) return null;
  const [id, rawFen, movesText, rating, ratingDeviation, popularity, plays, themesText, gameUrl, openingTags = ""] = fields;
  const moves = movesText.trim().split(/\s+/).filter(Boolean);
  if (moves.length < 2) return null;
  let fen;
  try { fen = withFenCounters(rawFen); }
  catch { return null; }
  const before = new Chess(fen);
  const setup = findLegalMove(before, moves[0]);
  if (!setup) return null;
  before.move({ from: setup.from, to: setup.to, promotion: setup.promotion });
  const puzzleFen = before.fen();
  const solution = canonicalUci(puzzleFen, moves[1]);
  if (!solution) return null;
  return {
    id,
    fen,
    side: fen.split(" ")[1],
    puzzleFen,
    puzzleSide: puzzleFen.split(" ")[1],
    setupMove: canonicalUci(fen, moves[0]),
    solution,
    moves,
    rating: Number(rating),
    ratingDeviation: Number(ratingDeviation),
    popularity: Number(popularity),
    plays: Number(plays),
    themes: themesText.split(/\s+/).filter(Boolean),
    gameUrl,
    openingTags: openingTags.split(/\s+/).filter(Boolean),
  };
}

export async function loadPuzzleCohort(path, limit, offset = 0) {
  const reader = inputLines(path);
  const quota = balancedQuota(limit);
  const counts = { w: 0, b: 0 };
  const records = [];
  const seen = new Set();
  let skipped = 0;
  try {
    for await (const line of reader.lines) {
      const puzzle = parsePuzzleRecord(line);
      if (!puzzle) continue;
      if (skipped < offset) {
        skipped += 1;
        continue;
      }
      if (counts[puzzle.puzzleSide] >= quota[puzzle.puzzleSide] || seen.has(puzzle.puzzleFen)) continue;
      records.push(puzzle);
      counts[puzzle.puzzleSide] += 1;
      seen.add(puzzle.puzzleFen);
      if (records.length >= limit) break;
    }
  } finally { reader.close(); }
  if (records.length < limit) throw new Error(`Only found ${records.length} usable balanced puzzles; requested ${limit}.`);
  return records;
}

function moveUci(move) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function findLegalMove(chess, requested) {
  const value = String(requested || "").toLowerCase();
  const legal = chess.moves({ verbose: true });
  const exact = legal.find(move => moveUci(move) === value || moveUci(move).slice(0, 4) === value.slice(0, 4) && !value[4]);
  if (exact) return exact;
  const piece = chess.get(value.slice(0, 2));
  const target = chess.get(value.slice(2, 4));
  if (piece?.type !== "k" || target?.type !== "r" || piece.color !== target.color) return null;
  const kingSide = value.charCodeAt(2) > value.charCodeAt(0);
  return legal.find(move => move.san === (kingSide ? "O-O" : "O-O-O")) || null;
}

export function canonicalUci(fen, requested) {
  try {
    const move = findLegalMove(new Chess(fen), requested);
    return move ? moveUci(move) : null;
  } catch { return null; }
}

class StockfishProcess {
  constructor(depth) {
    this.name = `Stockfish 18 Lite depth ${depth}`;
    this.id = "stockfish";
    this.depth = depth;
    this.child = null;
    this.buffer = "";
    this.waiters = [];
    this.pending = null;
  }

  async init() {
    this.child = spawn(process.execPath, [STOCKFISH_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => this.consume(chunk));
    this.child.on("error", error => this.fail(error));
    this.child.on("exit", code => {
      if (code && this.pending) this.fail(new Error(`Stockfish exited with code ${code}.`));
    });
    const uci = this.waitFor("uciok");
    this.child.stdin.write("uci\n");
    await uci;
    this.child.stdin.write("setoption name Hash value 32\n");
    const ready = this.waitFor("readyok");
    this.child.stdin.write("isready\n");
    await ready;
  }

  consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines.map(item => item.trim()).filter(Boolean)) this.onLine(line);
  }

  onLine(line) {
    const waiter = this.waiters.find(item => line.includes(item.token));
    if (waiter) {
      this.waiters = this.waiters.filter(item => item !== waiter);
      waiter.resolve(line);
    }
    if (!this.pending) return;
    if (line.startsWith("info ") && line.includes(" score ")) {
      const parsed = parseInfoLine(line);
      if (parsed && parsed.depth >= this.pending.result.depth) this.pending.result = {
        depth: parsed.depth,
        cp: parsed.scoreCp,
        mate: parsed.mate,
        pv: parsed.pv,
      };
    } else if (line.startsWith("bestmove ")) {
      const pending = this.pending;
      this.pending = null;
      pending.resolve({ ...pending.result, bestmove: line.split(/\s+/)[1] });
    }
  }

  waitFor(token) {
    return new Promise((resolvePromise, reject) => this.waiters.push({ token, resolve: resolvePromise, reject }));
  }

  fail(error) {
    this.pending?.reject(error);
    this.pending = null;
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters = [];
  }

  evaluate(fen, searchMoves = null) {
    if (this.pending) return Promise.reject(new Error("Stockfish received overlapping searches."));
    return new Promise((resolvePromise, reject) => {
      this.pending = { resolve: resolvePromise, reject, result: { depth: 0, cp: 0, mate: null, pv: [] } };
      this.child.stdin.write(`position fen ${fen}\n`);
      const moves = Array.isArray(searchMoves) ? searchMoves.join(" ") : searchMoves;
      this.child.stdin.write(`go depth ${this.depth}${moves ? ` searchmoves ${moves}` : ""}\n`);
    });
  }

  close() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.stdin.write("quit\n");
    this.child.kill();
  }
}

class RecklessProcess {
  constructor(nodes) {
    this.name = `Reckless alpha ${nodes.toLocaleString()} nodes`;
    this.id = "reckless";
    this.nodes = nodes;
    this.engine = null;
  }

  async init() {
    const parts = await Promise.all([0, 1, 2, 3].map(index => readFile(resolve(RECKLESS_DIRECTORY, `reckless_bg.wasm.part${index}`))));
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    await initReckless({ module_or_path: bytes });
    this.engine = new RecklessWasmEngine();
    this.engine.set_threads(1);
  }

  async evaluate(fen, searchMoves = null) {
    this.engine.set_position(fen);
    let result = { depth: 0, cp: 0, mate: null, pv: [] };
    const callback = line => {
      const parsed = parseInfoLine(line);
      if (parsed?.multiPv === 1 && parsed.depth >= result.depth) result = {
        depth: parsed.depth,
        cp: parsed.scoreCp,
        mate: parsed.mate,
        pv: parsed.pv,
      };
    };
    const moves = Array.isArray(searchMoves) ? searchMoves.join(" ") : searchMoves;
    if (moves) this.engine.go_uci_searchmoves(0, this.nodes, 1, moves, callback);
    else this.engine.go_uci(0, this.nodes, 1, callback);
    return { ...result, bestmove: this.engine.last_bestmove() };
  }

  close() {
    this.engine?.free();
    this.engine = null;
  }
}

function referenceMove(fen, uci) {
  return canonicalUci(fen, uci) || uci;
}

function scoreSign(value, deadZone = 30) {
  if (value > deadZone) return 1;
  if (value < -deadZone) return -1;
  return 0;
}

function percentage(numerator, denominator) {
  return denominator ? Number((100 * numerator / denominator).toFixed(2)) : null;
}

function mean(values) {
  return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : null;
}

const SPECIFIC_THEME_SET = new Set(TACTICAL_SPECIFIC_THEMES);

function recordThemeMetrics(metrics, classification, officialThemes, example) {
  const officialSpecific = officialThemes.filter(theme => SPECIFIC_THEME_SET.has(theme));
  if (officialSpecific.length) {
    metrics.officialSpecificPositions += 1;
    if (classification.specificThemes.some(theme => officialSpecific.includes(theme))) metrics.specificPositionsRecalled += 1;
  }
  if (classification.primary !== "calculation") {
    metrics.specificPredictions += 1;
    if (officialThemes.includes(classification.primary)) metrics.specificPredictionMatches += 1;
    else if (metrics.labelErrors.length < 20) metrics.labelErrors.push({
      ...example,
      predicted: classification.primary,
      predictedThemes: classification.specificThemes,
      officialThemes,
    });
  }
}

async function benchmarkEvaluations(engine, cohort, progress) {
  const metrics = {
    positions: cohort.length,
    legal: 0,
    exactTop1: 0,
    withinMultiPv: 0,
    signComparable: 0,
    signAgreement: 0,
    cpDeltas: [],
    bySide: { w: { positions: 0, exactTop1: 0 }, b: { positions: 0, exactTop1: 0 } },
    blackMultiPvChoices: 0,
    blackWhiteMaxTrapMatches: 0,
    errors: [],
  };
  for (let index = 0; index < cohort.length; index += 1) {
    const position = cohort[index];
    metrics.bySide[position.side].positions += 1;
    try {
      const result = await engine.evaluate(position.fen);
      const actual = canonicalUci(position.fen, result.bestmove);
      if (actual) metrics.legal += 1;
      const trusted = referenceMove(position.fen, position.reference.primaryMove);
      if (actual === trusted) {
        metrics.exactTop1 += 1;
        metrics.bySide[position.side].exactTop1 += 1;
      }
      const alternatives = position.reference.alternatives.map(item => referenceMove(position.fen, item.move));
      if (alternatives.includes(actual)) metrics.withinMultiPv += 1;
      const referenceCp = position.reference.primary.cp;
      if (referenceCp !== undefined && result.cp !== null) {
        const expectedSideScore = lichessCentipawnsToSideToMove(referenceCp, position.fen);
        metrics.cpDeltas.push(Math.abs(sideToMoveScore(result) - expectedSideScore));
        if (scoreSign(expectedSideScore) !== 0) {
          metrics.signComparable += 1;
          if (scoreSign(sideToMoveScore(result)) === scoreSign(expectedSideScore)) metrics.signAgreement += 1;
        }
      }
      if (position.side === "b") {
        const numeric = position.reference.alternatives.filter(item => Number.isFinite(Number(item.cp)));
        if (numeric.length >= 2) {
          const whiteMax = numeric.reduce((best, item) => Number(item.cp) > Number(best.cp) ? item : best);
          const whiteMaxMove = referenceMove(position.fen, whiteMax.move);
          if (alternatives.includes(actual)) metrics.blackMultiPvChoices += 1;
          if (actual === whiteMaxMove && whiteMaxMove !== trusted) metrics.blackWhiteMaxTrapMatches += 1;
        }
      }
    } catch (error) {
      metrics.errors.push({ fen: position.fen, message: error.message });
    }
    progress(index + 1, cohort.length);
  }
  return {
    positions: metrics.positions,
    legalRate: percentage(metrics.legal, metrics.positions),
    exactTop1Rate: percentage(metrics.exactTop1, metrics.positions),
    withinAvailableMultiPvRate: percentage(metrics.withinMultiPv, metrics.positions),
    decisiveScoreSignAgreementRate: percentage(metrics.signAgreement, metrics.signComparable),
    meanAbsoluteCentipawnDelta: mean(metrics.cpDeltas),
    bySide: {
      white: { positions: metrics.bySide.w.positions, exactTop1Rate: percentage(metrics.bySide.w.exactTop1, metrics.bySide.w.positions) },
      black: { positions: metrics.bySide.b.positions, exactTop1Rate: percentage(metrics.bySide.b.exactTop1, metrics.bySide.b.positions) },
    },
    blackWhiteMaxTrapMatches: metrics.blackWhiteMaxTrapMatches,
    blackChoicesWithinMultiPv: metrics.blackMultiPvChoices,
    errors: metrics.errors.slice(0, 20),
  };
}

async function benchmarkPuzzles(engine, cohort, progress) {
  const metrics = {
    positions: cohort.length,
    legal: 0,
    solved: 0,
    bySide: { w: { positions: 0, solved: 0 }, b: { positions: 0, solved: 0 } },
    specificPredictions: 0,
    specificPredictionMatches: 0,
    officialSpecificPositions: 0,
    specificPositionsRecalled: 0,
    labelErrors: [],
    errors: [],
  };
  for (let index = 0; index < cohort.length; index += 1) {
    const puzzle = cohort[index];
    metrics.bySide[puzzle.puzzleSide].positions += 1;
    try {
      const result = await engine.evaluate(puzzle.puzzleFen);
      const actual = canonicalUci(puzzle.puzzleFen, result.bestmove);
      if (actual) metrics.legal += 1;
      if (actual === puzzle.solution) {
        metrics.solved += 1;
        metrics.bySide[puzzle.puzzleSide].solved += 1;
      }
      const classification = classifySolutionThemes({ fen: puzzle.puzzleFen, moves: puzzle.moves.slice(1), result });
      recordThemeMetrics(metrics, classification, puzzle.themes, { id: puzzle.id, fen: puzzle.puzzleFen });
    } catch (error) {
      metrics.errors.push({ id: puzzle.id, fen: puzzle.puzzleFen, message: error.message });
    }
    progress(index + 1, cohort.length);
  }
  return {
    positions: metrics.positions,
    legalRate: percentage(metrics.legal, metrics.positions),
    exactOnlyMoveSolveRate: percentage(metrics.solved, metrics.positions),
    bySide: {
      white: { positions: metrics.bySide.w.positions, solveRate: percentage(metrics.bySide.w.solved, metrics.bySide.w.positions) },
      black: { positions: metrics.bySide.b.positions, solveRate: percentage(metrics.bySide.b.solved, metrics.bySide.b.positions) },
    },
    specificLabelCoverageRate: percentage(metrics.specificPredictions, metrics.positions),
    specificLabelPrecisionRate: percentage(metrics.specificPredictionMatches, metrics.specificPredictions),
    officialSpecificThemePositionRecallRate: percentage(metrics.specificPositionsRecalled, metrics.officialSpecificPositions),
    labelErrors: metrics.labelErrors,
    errors: metrics.errors.slice(0, 20),
  };
}

async function benchmarkReport(engine, cohort, progress) {
  const metrics = {
    positions: cohort.length,
    detected: 0,
    replyComparable: 0,
    replyMatches: 0,
    detectedReplyMatches: 0,
    specificPredictions: 0,
    specificPredictionMatches: 0,
    officialSpecificPositions: 0,
    specificPositionsRecalled: 0,
    labelErrors: [],
    losses: [],
    thresholdSensitivity: new Map([80, 90, 100, 110, 120].map(threshold => [threshold, {
      detected: 0,
      endToEnd: 0,
      bySide: { w: { detected: 0, endToEnd: 0 }, b: { detected: 0, endToEnd: 0 } },
    }])),
    bySide: {
      w: { positions: 0, detected: 0, detectedReplyMatches: 0 },
      b: { positions: 0, detected: 0, detectedReplyMatches: 0 },
    },
    errors: [],
  };
  for (let index = 0; index < cohort.length; index += 1) {
    const puzzle = cohort[index];
    metrics.bySide[puzzle.side].positions += 1;
    try {
      const best = await engine.evaluate(puzzle.fen);
      const played = await engine.evaluate(puzzle.fen, puzzle.setupMove);
      const loss = centipawnLoss(best, played);
      metrics.losses.push(loss);
      const pvReply = played.pv?.[0] === puzzle.setupMove ? played.pv[1] : played.pv?.[0];
      let replyMatches = false;
      if (pvReply) {
        metrics.replyComparable += 1;
        replyMatches = referenceMove(puzzle.puzzleFen, pvReply) === puzzle.solution;
        if (replyMatches) metrics.replyMatches += 1;
      }
      for (const [threshold, values] of metrics.thresholdSensitivity) {
        if (loss < threshold) continue;
        values.detected += 1;
        values.bySide[puzzle.side].detected += 1;
        if (replyMatches) values.endToEnd += 1;
        if (replyMatches) values.bySide[puzzle.side].endToEnd += 1;
      }
      if (loss >= MIN_REPORT_LOSS) {
        metrics.detected += 1;
        metrics.bySide[puzzle.side].detected += 1;
        if (replyMatches) {
          metrics.detectedReplyMatches += 1;
          metrics.bySide[puzzle.side].detectedReplyMatches += 1;
        }
        const classification = classifyReportThemes({ fen: puzzle.fen, best, playedUci: puzzle.setupMove, played });
        recordThemeMetrics(metrics, { ...classification, primary: classification.rawPrimary }, puzzle.themes, { id: puzzle.id, fen: puzzle.fen });
      }
    } catch (error) {
      metrics.errors.push({ id: puzzle.id, fen: puzzle.fen, message: error.message });
    }
    progress(index + 1, cohort.length);
  }
  return {
    positions: metrics.positions,
    reportThresholdCentipawns: MIN_REPORT_LOSS,
    tacticalMistakeDetectionRate: percentage(metrics.detected, metrics.positions),
    constrainedPvFindsLichessReplyRate: percentage(metrics.replyMatches, metrics.replyComparable),
    endToEndTacticalAgreementRate: percentage(metrics.detectedReplyMatches, metrics.positions),
    meanDetectedCentipawnLoss: mean(metrics.losses.filter(loss => loss >= MIN_REPORT_LOSS)),
    thresholdSensitivity: Object.fromEntries([...metrics.thresholdSensitivity].map(([threshold, values]) => [threshold, {
      tacticalMistakeDetectionRate: percentage(values.detected, metrics.positions),
      endToEndTacticalAgreementRate: percentage(values.endToEnd, metrics.positions),
      byBlunderingSide: {
        white: {
          detectionRate: percentage(values.bySide.w.detected, metrics.bySide.w.positions),
          endToEndAgreementRate: percentage(values.bySide.w.endToEnd, metrics.bySide.w.positions),
        },
        black: {
          detectionRate: percentage(values.bySide.b.detected, metrics.bySide.b.positions),
          endToEndAgreementRate: percentage(values.bySide.b.endToEnd, metrics.bySide.b.positions),
        },
      },
    }])),
    byBlunderingSide: {
      white: {
        positions: metrics.bySide.w.positions,
        detectionRate: percentage(metrics.bySide.w.detected, metrics.bySide.w.positions),
        endToEndAgreementRate: percentage(metrics.bySide.w.detectedReplyMatches, metrics.bySide.w.positions),
      },
      black: {
        positions: metrics.bySide.b.positions,
        detectionRate: percentage(metrics.bySide.b.detected, metrics.bySide.b.positions),
        endToEndAgreementRate: percentage(metrics.bySide.b.detectedReplyMatches, metrics.bySide.b.positions),
      },
    },
    specificLabelCoverageRate: percentage(metrics.specificPredictions, metrics.detected),
    specificLabelPrecisionRate: percentage(metrics.specificPredictionMatches, metrics.specificPredictions),
    officialSpecificThemePositionRecallRate: percentage(metrics.specificPositionsRecalled, metrics.officialSpecificPositions),
    labelErrors: metrics.labelErrors,
    errors: metrics.errors.slice(0, 20),
  };
}

function progressLogger(engine, phase) {
  let last = 0;
  return (completed, total) => {
    if (completed === total || completed - last >= 50) {
      last = completed;
      process.stdout.write(`${engine.name} · ${phase}: ${completed}/${total}\n`);
    }
  };
}

function functionalFailures(results) {
  const failures = [];
  for (const [engine, phases] of Object.entries(results.engines)) {
    for (const phase of ["evaluations", "puzzles"]) {
      const value = phases[phase];
      if (value.legalRate !== 100) failures.push(`${engine} ${phase} returned illegal or missing moves (${value.legalRate}% legal).`);
      if (value.errors.length) failures.push(`${engine} ${phase} had ${value.errors.length} recorded engine errors.`);
    }
    if (phases.evaluations.blackWhiteMaxTrapMatches > Math.max(2, phases.evaluations.blackChoicesWithinMultiPv * 0.2)) {
      failures.push(`${engine} disproportionately selected White-maximizing alternatives when Black was to move.`);
    }
  }
  if (results.report?.errors.length) failures.push(`Tactics Report benchmark had ${results.report.errors.length} recorded errors.`);
  return failures;
}

function qualityWarnings(results) {
  const warnings = [];
  for (const [engine, phases] of Object.entries(results.engines)) {
    if (phases.puzzles.exactOnlyMoveSolveRate < 95) warnings.push(`${engine} solved fewer than 95% of the Lichess only-move puzzle cohort.`);
    if (phases.evaluations.decisiveScoreSignAgreementRate < 95) warnings.push(`${engine} agreed with fewer than 95% of decisive Lichess evaluation signs.`);
  }
  if (results.report?.endToEndTacticalAgreementRate < 95) warnings.push("Tactics Report's end-to-end tactical agreement is below the 95% release target.");
  for (const [side, values] of Object.entries(results.report?.byBlunderingSide || {})) {
    if (values.endToEndAgreementRate < 95) warnings.push(`Tactics Report's ${side} end-to-end tactical agreement is below the 95% release target.`);
  }
  if (results.report?.specificLabelPrecisionRate < 95) warnings.push("Tactics Report's specific motif precision is below the 95% release target; general calculation labels are excluded.");
  return warnings;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.eval || !options.puzzles) throw new Error("Both --eval and --puzzles are required.\n\n" + usage());
  process.stdout.write(`Loading ${options.evalLimit} balanced Lichess evaluations…\n`);
  const evaluations = await loadEvaluationCohort(options.eval, options.evalLimit, options.evalOffset);
  process.stdout.write(`Loading ${options.puzzleLimit} balanced Lichess puzzles…\n`);
  const puzzles = await loadPuzzleCohort(options.puzzles, options.puzzleLimit, options.puzzleOffset);
  const results = {
    generatedAt: new Date().toISOString(),
    sources: {
      evaluations: "https://database.lichess.org/lichess_db_eval.jsonl.zst",
      puzzles: "https://database.lichess.org/lichess_db_puzzle.csv.zst",
      license: "CC0",
      note: "Deterministic leading-file sample, balanced by side to move; no full database download required.",
    },
    configuration: {
      evalLimit: options.evalLimit,
      evalOffset: options.evalOffset,
      puzzleLimit: options.puzzleLimit,
      puzzleOffset: options.puzzleOffset,
      reportLimit: Math.min(options.reportLimit, puzzles.length),
      stockfishDepth: options.stockfishDepth,
      recklessNodes: options.recklessNodes,
    },
    engines: {},
  };
  for (const engineId of options.engines) {
    const engine = engineId === "stockfish" ? new StockfishProcess(options.stockfishDepth) : new RecklessProcess(options.recklessNodes);
    process.stdout.write(`Initializing ${engine.name}…\n`);
    await engine.init();
    try {
      results.engines[engineId] = {
        name: engine.name,
        evaluations: await benchmarkEvaluations(engine, evaluations, progressLogger(engine, "evaluations")),
        puzzles: await benchmarkPuzzles(engine, puzzles, progressLogger(engine, "puzzles")),
      };
    } finally { engine.close(); }
  }
  if (options.reportLimit > 0) {
    const reportEngine = new StockfishProcess(options.stockfishDepth);
    process.stdout.write(`Initializing ${reportEngine.name} for Tactics Report end-to-end checks…\n`);
    await reportEngine.init();
    try {
      const reportPuzzles = puzzles.slice(0, Math.min(options.reportLimit, puzzles.length));
      results.report = await benchmarkReport(reportEngine, reportPuzzles, progressLogger(reportEngine, "report"));
    } finally { reportEngine.close(); }
  }
  results.functionalFailures = functionalFailures(results);
  results.qualityWarnings = qualityWarnings(results);
  const json = `${JSON.stringify(results, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, json, "utf8");
    process.stdout.write(`Wrote ${options.output}\n`);
  }
  process.stdout.write(json);
  if (results.functionalFailures.length) process.exitCode = 2;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
