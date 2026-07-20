import assert from "node:assert/strict";
import test from "node:test";
import { RecklessEngine } from "../static/vendor/reckless/reckless-engine.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const E4_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

class ScriptedWorker {
  constructor(url, options, behavior = {}) {
    this.url = url;
    this.options = options;
    this.behavior = behavior;
    this.listeners = { message: [], error: [] };
    this.messages = [];
    this.terminated = false;
    this.fen = START_FEN;
    this.pendingSearch = null;
  }

  addEventListener(type, listener) {
    this.listeners[type].push(listener);
  }

  postMessage(message) {
    this.messages.push(message);
    queueMicrotask(() => this.#handle(message));
  }

  terminate() {
    this.terminated = true;
  }

  emit(message) {
    for (const listener of this.listeners.message) listener({ data: message });
  }

  #respond(requestId, result) {
    this.emit({ type: "response", requestId, ok: true, result });
  }

  #handle(message) {
    if (this.terminated) return;
    if (message.type === "init") {
      this.emit({ type: "download-progress", requestId: message.requestId, loaded: 4, total: 4, url: `${message.assetBaseUrl}part3` });
      this.#respond(message.requestId, { name: "Reckless", version: "test", fen: this.fen });
      return;
    }
    if (message.type === "set-position") {
      this.fen = message.fen;
      this.#respond(message.requestId, { fen: this.fen });
      return;
    }
    if (message.type === "make-move") {
      if (message.move === "e2e5") {
        this.emit({
          type: "response",
          requestId: message.requestId,
          ok: false,
          error: { code: "ILLEGAL_MOVE", message: "Illegal move" },
        });
      } else {
        this.fen = E4_FEN;
        this.#respond(message.requestId, { move: message.move, fen: this.fen });
      }
      return;
    }
    if (message.type === "get-fen") {
      this.#respond(message.requestId, { fen: this.fen });
      return;
    }
    if (message.type === "new-game") {
      this.fen = START_FEN;
      this.#respond(message.requestId, { fen: this.fen });
      return;
    }
    if (message.type === "analyze") {
      if (this.behavior.holdSearch) {
        this.pendingSearch = message;
        return;
      }
      const info = {
        multiPv: 1,
        depth: 8,
        selDepth: 10,
        scoreCp: 35,
        mate: null,
        nodes: 4096,
        nps: 200000,
        timeMs: 20,
        pv: ["e2e4", "e7e5"],
        raw: "info depth 8 score cp 35 pv e2e4 e7e5",
      };
      this.emit({ type: "output", requestId: message.requestId, line: info.raw });
      this.emit({ type: "info", requestId: message.requestId, line: info.raw, info });
      const bestMove = Array.isArray(message.searchMoves) ? message.searchMoves[0] : "e2e4";
      this.#respond(message.requestId, {
        bestMove,
        scoreCp: 35,
        mate: null,
        depth: 8,
        nodes: 4096,
        lines: [info],
        fen: this.fen,
      });
    }
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("wrapper initializes with configurable assets and tracks requests", async () => {
  const workers = [];
  const engine = new RecklessEngine({
    assetBaseUrl: "https://cdn.example/reckless/0.1.0/",
    workerUrl: "https://app.example/workers/reckless-worker.js",
    wasmFile: "reckless_bg.wasm",
    workerFactory(url, options) {
      const worker = new ScriptedWorker(url, options);
      workers.push(worker);
      return worker;
    },
  });
  const info = [];
  const output = [];
  const progress = [];
  engine.onInfo((value) => info.push(value));
  engine.onOutput((value) => output.push(value));
  engine.onDownloadProgress((value) => progress.push(value));

  await engine.init();
  assert.equal(workers[0].url, "https://app.example/workers/reckless-worker.js");
  assert.equal(workers[0].options.type, "module");
  assert.equal(workers[0].messages[0].assetBaseUrl, "https://cdn.example/reckless/0.1.0/");
  assert.equal(workers[0].messages[0].wasmFile, "reckless_bg.wasm");
  assert.equal(progress.length, 1);

  await engine.setPosition(START_FEN);
  const moved = await engine.makeMove("e2e4");
  assert.equal(moved.fen, E4_FEN);
  await assert.rejects(engine.makeMove("e2e5"), (error) => error.code === "ILLEGAL_MOVE");

  const result = await engine.analyze({ movetime: 25, multiPv: 1 });
  assert.equal(result.bestMove, "e2e4");
  const constrained = await engine.analyze({ nodes: 1000, searchMoves: ["a2a3"] });
  assert.equal(constrained.bestMove, "a2a3");
  assert.equal(info.length, 2);
  assert.equal(output.length, 2);
  assert.equal(await engine.getFen(), E4_FEN);
  assert.equal(await engine.newGame(), START_FEN);

  const requestIds = workers[0].messages.map((message) => message.requestId);
  assert.equal(new Set(requestIds).size, requestIds.length);
  engine.terminate();
  assert.equal(workers[0].terminated, true);
});

test("a newer analysis terminates the old worker and ignores stale output", async () => {
  const workers = [];
  const engine = new RecklessEngine({
    assetBaseUrl: "https://assets.example/reckless/",
    workerFactory(url, options) {
      const worker = new ScriptedWorker(url, options, { holdSearch: workers.length === 0 });
      workers.push(worker);
      return worker;
    },
  });
  const info = [];
  engine.onInfo((value) => info.push(value));

  const first = engine.analyze({ movetime: 5000 });
  await tick();
  await tick();
  assert.ok(workers[0].pendingSearch, "first analysis should be active");

  const second = engine.analyze({ fen: START_FEN, movetime: 25 });
  await assert.rejects(first, (error) => error.name === "AbortError");
  const secondResult = await second;
  assert.equal(secondResult.bestMove, "e2e4");
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2);

  workers[0].emit({
    type: "info",
    requestId: workers[0].pendingSearch.requestId,
    info: { multiPv: 1, depth: 99, pv: ["a2a4"] },
  });
  assert.equal(info.length, 1, "stale worker output must be ignored");
  engine.terminate();
});

test("stop recreates the worker and terminate prevents reuse", async () => {
  const workers = [];
  const engine = new RecklessEngine({
    workerFactory(url, options) {
      const worker = new ScriptedWorker(url, options);
      workers.push(worker);
      return worker;
    },
  });

  await engine.init();
  await engine.setPosition(E4_FEN);
  await engine.stop();
  assert.equal(workers.length, 2);
  assert.equal(workers[0].terminated, true);
  assert.equal(await engine.getFen(), E4_FEN);
  engine.terminate();
  await assert.rejects(engine.init(), (error) => error.code === "TERMINATED");
});
