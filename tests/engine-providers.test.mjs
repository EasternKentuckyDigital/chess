import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserReckless,
  BrowserStockfish,
  ANALYSIS_LEVELS,
  RECKLESS_NODE_LIMIT,
  analysisLimits,
  engineDescriptor,
  engineDescriptors,
  engineFingerprint,
  normalizeRecklessResult,
  recklessAssetUrls,
} from "../static/lib/engine-providers.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function browserRuntime() {
  return { Worker: class {}, WebAssembly: {}, fetch() {}, addEventListener() {}, removeEventListener() {} };
}

class FakeRecklessEngine {
  constructor() {
    this.analysis = [];
    this.terminated = false;
    this.progressCallback = null;
  }

  onDownloadProgress(callback) {
    this.progressCallback = callback;
    return () => { this.progressCallback = null; };
  }

  async init() {
    this.progressCallback?.({ loaded: 64_464_038, total: 64_464_038 });
  }

  async analyze(options) {
    this.analysis.push(options);
    return {
      bestMove: options.searchMoves?.[0] || "e2e4",
      scoreCp: 34,
      mate: null,
      depth: 9,
      lines: [{ multiPv: 1, depth: 9, scoreCp: 34, mate: null, pv: [options.searchMoves?.[0] || "e2e4", "e7e5"] }],
    };
  }

  async stop() {}
  terminate() { this.terminated = true; }
}

test("registers distinct browser and cloud Reckless descriptors", () => {
  const ids = engineDescriptors().map((engine) => engine.id);
  assert.ok(ids.includes("stockfish-browser"));
  assert.ok(ids.includes("reckless-browser"));
  assert.ok(ids.includes("reckless"));
  assert.equal(new Set(ids).size, ids.length);
  const descriptor = engineDescriptor("reckless-browser");
  assert.equal(descriptor.tier, "free");
  assert.equal(descriptor.local, true);
  assert.equal(descriptor.releaseStage, "alpha");
  assert.match(descriptor.selectorName, /Alpha/);
  assert.match(descriptor.detail, /61\.5 MiB first-use download/);
  assert.equal(descriptor.supportsConstrainedSearch, true);
  assert.match(engineFingerprint(descriptor, "balanced"), new RegExp(`nodes-${RECKLESS_NODE_LIMIT}$`));
});

test("resolves Reckless assets at a domain root and GitHub Pages project path", () => {
  assert.deepEqual(recklessAssetUrls("https://example.test/lib/engine-providers.js"), {
    assetBaseUrl: "https://example.test/vendor/reckless/",
    wrapperUrl: "https://example.test/vendor/reckless/reckless-engine.js",
    workerUrl: "https://example.test/vendor/reckless/reckless-worker.js",
  });
  assert.deepEqual(recklessAssetUrls("https://example.test/chessreplaystatic/lib/engine-providers.js"), {
    assetBaseUrl: "https://example.test/chessreplaystatic/vendor/reckless/",
    wrapperUrl: "https://example.test/chessreplaystatic/vendor/reckless/reckless-engine.js",
    workerUrl: "https://example.test/chessreplaystatic/vendor/reckless/reckless-worker.js",
  });
});

test("BrowserReckless initializes lazily and normalizes FEN and constrained analysis", async () => {
  const wrapped = new FakeRecklessEngine();
  const engine = new BrowserReckless({ engine: wrapped, runtime: browserRuntime() });
  const progress = [];
  engine.onProgress((value) => progress.push(value));
  await engine.init();
  const result = await engine.evaluate(START_FEN, ["a2a3"]);
  assert.deepEqual(result, { bestmove: "a2a3", depth: 9, cp: 34, mate: null, pv: ["a2a3", "e7e5"] });
  assert.equal(wrapped.analysis[0].fen, START_FEN);
  assert.equal(wrapped.analysis[0].nodes, RECKLESS_NODE_LIMIT);
  assert.deepEqual(wrapped.analysis[0].searchMoves, ["a2a3"]);
  assert.equal(progress.length, 1);
  engine.close();
  assert.equal(wrapped.terminated, true);
});

test("normalizes mate scores without inventing centipawns", () => {
  assert.deepEqual(normalizeRecklessResult({
    bestMove: "h5h7",
    scoreCp: null,
    mate: 2,
    depth: 7,
    lines: [{ multiPv: 1, pv: ["h5h7", "e8f8", "h7h8"] }],
  }), { bestmove: "h5h7", depth: 7, cp: null, mate: 2, pv: ["h5h7", "e8f8", "h7h8"] });
});

test("reports unsupported browser and missing asset failures clearly", async () => {
  const unsupported = new BrowserReckless({ engine: new FakeRecklessEngine(), runtime: { WebAssembly: {}, fetch() {} } });
  await assert.rejects(unsupported.init(), /Web Worker support/);
  unsupported.close();

  const missingAssetEngine = new FakeRecklessEngine();
  missingAssetEngine.init = async () => {
    const error = new Error("Unable to load asset https://example.test/reckless_bg.wasm.part2 (404 Not Found)");
    error.code = "ASSET_LOAD_ERROR";
    throw error;
  };
  const missing = new BrowserReckless({ engine: missingAssetEngine, runtime: browserRuntime() });
  await assert.rejects(missing.init(), /61\.5 MiB browser package.*part2.*404/);
  missing.close();
});

test("prevents a stale Reckless result from replacing a newer position", async () => {
  const resolvers = [];
  const wrapped = new FakeRecklessEngine();
  wrapped.analyze = (options) => new Promise((resolve) => resolvers.push({ options, resolve }));
  const engine = new BrowserReckless({ engine: wrapped, runtime: browserRuntime() });
  await engine.init();
  const first = engine.evaluate(START_FEN);
  const second = engine.evaluate(START_FEN, ["d2d4"]);
  resolvers[1].resolve({ bestMove: "d2d4", scoreCp: 10, mate: null, depth: 5, lines: [{ multiPv: 1, pv: ["d2d4"] }] });
  assert.equal((await second).bestmove, "d2d4");
  resolvers[0].resolve({ bestMove: "e2e4", scoreCp: 20, mate: null, depth: 5, lines: [{ multiPv: 1, pv: ["e2e4"] }] });
  await assert.rejects(first, (error) => error.name === "AbortError");
  engine.close();
});

test("Stockfish uses the beta depth and searchmoves contract", async () => {
  const previousWorker = globalThis.Worker;
  class FakeStockfishWorker {
    constructor() { this.commands = []; }
    postMessage(command) {
      this.commands.push(command);
      queueMicrotask(() => {
        if (command === "uci") this.onmessage?.({ data: "uciok" });
        else if (command === "isready") this.onmessage?.({ data: "readyok" });
        else if (command.startsWith("go depth")) {
          this.onmessage?.({ data: "info depth 18 score cp 21 pv e2e4 e7e5" });
          this.onmessage?.({ data: "bestmove e2e4" });
        }
      });
    }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = FakeStockfishWorker;
  try {
    const engine = new BrowserStockfish();
    await engine.init();
    const result = await engine.evaluate(START_FEN, ["e2e4"]);
    assert.deepEqual(result, { bestmove: "e2e4", depth: 18, cp: 21, mate: null, pv: ["e2e4", "e7e5"] });
    assert.ok(engine.worker.commands.includes("go depth 18 searchmoves e2e4"));
    engine.close();
    assert.equal(engine.worker.terminated, true);
  } finally {
    if (previousWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = previousWorker;
  }
});

test("analysis levels increase both local engine budgets", () => {
  assert.equal(analysisLimits("quick").stockfishDepth, 16);
  assert.equal(analysisLimits("quick").recklessNodes, 400_000);
  assert.equal(analysisLimits("balanced").stockfishDepth, 18);
  assert.equal(analysisLimits("deep").stockfishDepth, 22);
  assert.ok(ANALYSIS_LEVELS.quick.recklessNodes < ANALYSIS_LEVELS.balanced.recklessNodes);
  assert.ok(ANALYSIS_LEVELS.balanced.recklessNodes < ANALYSIS_LEVELS.deep.recklessNodes);
  const deep = new BrowserReckless({ engine: new FakeRecklessEngine(), runtime: browserRuntime(), level: "deep" });
  assert.equal(deep.nodes, ANALYSIS_LEVELS.deep.recklessNodes);
  deep.close();
});
