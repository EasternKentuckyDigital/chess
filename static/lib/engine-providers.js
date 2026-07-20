import { replayConfig } from "../config.js";

export const SEARCH_DEPTH = 18;
export const RECKLESS_NODE_LIMIT = Math.min(2_000_000, Math.max(1_000, Number(replayConfig.browserReckless?.nodes) || 750_000));
export const ANALYSIS_LEVELS = Object.freeze({
  superquick: Object.freeze({ id: "superquick", label: "Super quick", stockfishDepth: 16, recklessNodes: 400_000, detail: "Default release-tested baseline for fast local analysis." }),
  quick: Object.freeze({ id: "quick", label: "Quick", stockfishDepth: 17, recklessNodes: 550_000, detail: "A little stronger while remaining responsive on most computers." }),
  balanced: Object.freeze({ id: "balanced", label: "Balanced", stockfishDepth: SEARCH_DEPTH, recklessNodes: RECKLESS_NODE_LIMIT, detail: "Recommended balance of strength and wait time." }),
  deep: Object.freeze({ id: "deep", label: "Deep", stockfishDepth: 22, recklessNodes: 2_000_000, detail: "Stronger analysis that can be several times slower." }),
});

export function normalizeAnalysisLevel(level) {
  return ANALYSIS_LEVELS[level] ? level : "superquick";
}

export function analysisLimits(level = "superquick") {
  return ANALYSIS_LEVELS[normalizeAnalysisLevel(level)];
}

export function engineFingerprint(provider, level = "superquick") {
  const limits = analysisLimits(level);
  return `${provider.fingerprint}:${limits.id}:${provider.id === "reckless-browser" ? `nodes-${limits.recklessNodes}` : `depth-${limits.stockfishDepth}`}`;
}

const RECKLESS_BROWSER_VERSION = "0.1.0";
const RECKLESS_ENGINE_COMMIT = "a6fa482c";

const browserDescriptor = {
  id: "stockfish-browser",
  name: "Stockfish 18",
  selectorName: "Stockfish 18 — browser",
  detail: "Runs privately in this browser",
  tier: "free",
  configured: true,
  local: true,
  supportsConstrainedSearch: true,
  fingerprint: "stockfish-18-lite-single",
};

const recklessBrowserDescriptor = {
  id: "reckless-browser",
  name: "Reckless (alpha)",
  selectorName: "Reckless browser — Alpha",
  detail: "Runs privately in this browser · may require a 61.5 MiB first-use download",
  caution: "Alpha software. This single-threaded browser build may be slower than native Reckless and can use substantial memory, battery, and mobile data.",
  releaseStage: "alpha",
  tier: "free",
  configured: true,
  local: true,
  supportsConstrainedSearch: true,
  downloadBytes: 64_464_038,
  fingerprint: `reckless-browser:${RECKLESS_BROWSER_VERSION}:${RECKLESS_ENGINE_COMMIT}:searchmoves-v1`,
};

export function engineDescriptors() {
  return [
    browserDescriptor,
    recklessBrowserDescriptor,
    ...replayConfig.remoteEngines.map(engine => ({
      ...engine,
      detail: engine.description,
      tier: engine.tier || "plus",
      configured: Boolean(engine.endpoint),
      local: false,
      supportsConstrainedSearch: true,
      fingerprint: `${engine.id}:${engine.version || "remote-v1"}:depth-12`,
    })),
  ];
}

export function engineDescriptor(id) {
  return engineDescriptors().find(engine => engine.id === id) || browserDescriptor;
}

export class BrowserStockfish {
  constructor(options = {}) {
    this.level = normalizeAnalysisLevel(options.level);
    this.depth = Number(options.depth) || analysisLimits(this.level).stockfishDepth;
    this.descriptor = { ...browserDescriptor, fingerprint: engineFingerprint(browserDescriptor, this.level) };
    this.worker = new Worker(new URL("../vendor/stockfish/stockfish-18-lite-single.js", import.meta.url));
    this.waiters = [];
    this.pending = null;
    this.closed = false;
    this.worker.onmessage = event => this.onMessage(String(event.data ?? ""));
    this.worker.onerror = error => {
      if (this.pending) {
        this.pending.reject(new Error("Stockfish could not start in this browser."));
        this.pending = null;
      }
      console.error(error);
    };
  }

  send(command) { this.worker.postMessage(command); }

  waitFor(token, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Stockfish timed out waiting for ${token}.`)), timeout);
      this.waiters.push({
        token,
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
    });
  }

  async init() {
    this.send("uci");
    await this.waitFor("uciok");
    this.send("setoption name Hash value 32");
    this.send("isready");
    await this.waitFor("readyok");
  }

  onMessage(payload) {
    for (const line of payload.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
      const waiter = this.waiters.find(item => line.includes(item.token));
      if (waiter) {
        this.waiters = this.waiters.filter(item => item !== waiter);
        waiter.resolve(line);
      }
      if (!this.pending) continue;
      if (line.startsWith("info ") && line.includes(" score ")) {
        const parsed = parseInfo(line);
        if (parsed && parsed.depth >= this.pending.result.depth) this.pending.result = parsed;
      }
      if (line.startsWith("bestmove ")) {
        const bestmove = line.split(/\s+/)[1];
        const pending = this.pending;
        this.pending = null;
        pending.resolve({ ...pending.result, bestmove });
      }
    }
  }

  evaluate(fen, searchMoves = null) {
    return new Promise((resolve, reject) => {
      if (this.pending) return reject(new Error("Stockfish received overlapping searches."));
      this.pending = { resolve, reject, result: { depth: 0, cp: 0, mate: null, pv: [] } };
      this.send(`position fen ${fen}`);
      const moves = Array.isArray(searchMoves) ? searchMoves.join(" ") : searchMoves;
      this.send(`go depth ${this.depth}${moves ? ` searchmoves ${moves}` : ""}`);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const error = cancellationError("Stockfish analysis was cancelled.");
    if (this.pending) {
      this.pending.reject(error);
      this.pending = null;
    }
    this.waiters.forEach(waiter => waiter.reject(error));
    this.waiters = [];
    this.send("quit");
    this.worker.terminate();
  }
}

export function recklessAssetUrls(moduleUrl = import.meta.url) {
  const assetBaseUrl = new URL("../vendor/reckless/", moduleUrl).href;
  return {
    assetBaseUrl,
    wrapperUrl: new URL("../vendor/reckless/reckless-engine.js", moduleUrl).href,
    workerUrl: new URL("../vendor/reckless/reckless-worker.js", moduleUrl).href,
  };
}

function cancellationError(message = "Engine analysis was cancelled.") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORTED";
  return error;
}

export function isEngineCancellation(error) {
  return error?.name === "AbortError" || error?.code === "ABORTED";
}

function recklessSupportError(runtime) {
  if (typeof runtime?.Worker === "undefined") return "Reckless requires Web Worker support. Update to a current browser and try again.";
  if (typeof runtime?.WebAssembly === "undefined") return "Reckless requires WebAssembly support. Update to a current browser and try again.";
  if (typeof runtime?.fetch !== "function") return "Reckless requires the browser Fetch API to download its local engine package.";
  return null;
}

function explainRecklessError(error) {
  if (isEngineCancellation(error)) return error;
  const message = String(error?.message || error || "Reckless failed to start.");
  if (error?.code === "UNSUPPORTED_BROWSER") return new Error(message);
  if (error?.code === "UNSUPPORTED_SEARCH_MOVES") {
    return new Error("This Reckless browser build cannot run constrained searchmoves, so DoBackChess will not use an unrestricted result in its place.");
  }
  if (["ASSET_LOAD_ERROR", "INVALID_WASM", "WASM_INIT_ERROR", "INVALID_BINDINGS"].includes(error?.code)) {
    return new Error(`Reckless could not load its 61.5 MiB browser package. ${message}`);
  }
  if (error?.code === "WORKER_ERROR" || error?.code === "WORKER_UNAVAILABLE") {
    return new Error(`The Reckless browser worker could not start. ${message}`);
  }
  return new Error(message);
}

export function normalizeRecklessResult(data) {
  const primary = data?.lines?.find(line => line.multiPv === 1) || data?.lines?.[0] || null;
  const bestmove = String(data?.bestMove || "");
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(bestmove)) throw new Error("Reckless returned an invalid best move.");
  return {
    bestmove,
    depth: Number(data.depth ?? primary?.depth) || 0,
    cp: data.scoreCp == null ? (primary?.scoreCp == null ? null : Number(primary.scoreCp)) : Number(data.scoreCp),
    mate: data.mate == null ? (primary?.mate == null ? null : Number(primary.mate)) : Number(data.mate),
    pv: Array.isArray(primary?.pv) ? primary.pv.map(String) : [],
  };
}

function normalizedSearchMoves(searchMoves) {
  if (searchMoves == null || searchMoves === "") return null;
  const moves = (Array.isArray(searchMoves) ? searchMoves : String(searchMoves).split(/\s+/)).map(String).filter(Boolean);
  return moves.length ? moves : null;
}

export class BrowserReckless {
  constructor(options = {}) {
    this.level = normalizeAnalysisLevel(options.level);
    this.nodes = Number(options.nodes) || analysisLimits(this.level).recklessNodes;
    this.descriptor = { ...recklessBrowserDescriptor, fingerprint: engineFingerprint(recklessBrowserDescriptor, this.level) };
    this.runtime = options.runtime || globalThis;
    this.closed = false;
    this.sequence = 0;
    const urls = options.urls || recklessAssetUrls();
    this.urls = urls;
    this.engine = options.engine || null;
    this.enginePromise = null;
    this.progressCallbacks = new Set();
    this.removeEngineProgress = null;
    if (this.engine) this.attachProgress();
    this.onPageClose = () => this.close();
    this.runtime.addEventListener?.("pagehide", this.onPageClose, { once: true });
  }

  async init() {
    if (this.closed) throw new Error("This Reckless engine has already been closed.");
    const supportError = recklessSupportError(this.runtime);
    if (supportError) throw new Error(supportError);
    try {
      await this.loadEngine();
      await this.engine.init();
    } catch (error) {
      throw explainRecklessError(error);
    }
  }

  onProgress(callback) {
    if (typeof callback !== "function") throw new TypeError("onProgress requires a callback");
    this.progressCallbacks.add(callback);
    return () => this.progressCallbacks.delete(callback);
  }

  attachProgress() {
    this.removeEngineProgress?.();
    this.removeEngineProgress = this.engine.onDownloadProgress(progress => {
      this.progressCallbacks.forEach(callback => callback(progress));
    });
  }

  async loadEngine() {
    if (this.engine) return this.engine;
    if (!this.enginePromise) {
      this.enginePromise = import(this.urls.wrapperUrl)
        .then(({ RecklessEngine }) => {
          if (this.closed) throw cancellationError("Reckless initialization was cancelled.");
          this.engine = new RecklessEngine({
            assetBaseUrl: this.urls.assetBaseUrl,
            workerUrl: this.urls.workerUrl,
          });
          this.attachProgress();
          return this.engine;
        })
        .catch(error => {
          this.enginePromise = null;
          if (isEngineCancellation(error)) throw error;
          const wrapped = new Error(`Unable to import the Reckless browser wrapper from ${this.urls.wrapperUrl}: ${error?.message || error}`);
          wrapped.code = "ASSET_LOAD_ERROR";
          throw wrapped;
        });
    }
    return this.enginePromise;
  }

  async evaluate(fen, searchMoves = null) {
    if (this.closed) throw new Error("This Reckless engine has already been closed.");
    const token = ++this.sequence;
    try {
      const result = await this.engine.analyze({
        fen,
        nodes: this.nodes,
        multiPv: 1,
        searchMoves: normalizedSearchMoves(searchMoves),
      });
      if (token !== this.sequence || this.closed) throw cancellationError("Reckless analysis was replaced by a newer position.");
      return normalizeRecklessResult(result);
    } catch (error) {
      throw explainRecklessError(error);
    }
  }

  async cancel() {
    ++this.sequence;
    if (this.closed) return;
    try {
      await this.engine.stop();
    } catch (error) {
      if (!isEngineCancellation(error)) throw explainRecklessError(error);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    ++this.sequence;
    this.runtime.removeEventListener?.("pagehide", this.onPageClose);
    this.removeEngineProgress?.();
    this.progressCallbacks.clear();
    this.engine?.terminate();
  }
}

class RemoteEngine {
  constructor(descriptor, options = {}) {
    this.descriptor = descriptor;
    this.depth = analysisLimits(options.level).stockfishDepth;
  }

  async init() {
    if (!this.descriptor.endpoint) throw new Error(`${this.descriptor.name} is not configured yet.`);
  }

  async evaluate(fen, searchMoves = null) {
    const token = sessionStorage.getItem("replay:engine-access-token");
    const response = await fetch(this.descriptor.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ fen, searchMoves: searchMoves ? (Array.isArray(searchMoves) ? searchMoves : String(searchMoves).split(/\s+/)) : null, limit: { depth: this.depth } }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${this.descriptor.name} analysis failed.`);
    return normalizeResult(data);
  }

  close() {}
}

function normalizeResult(data) {
  const result = data.result || data;
  if (typeof result.bestmove !== "string") throw new Error("The remote engine returned an invalid result.");
  return {
    depth: Number(result.depth) || 0,
    cp: result.cp == null ? null : Number(result.cp),
    mate: result.mate == null ? null : Number(result.mate),
    pv: Array.isArray(result.pv) ? result.pv.map(String) : [],
    bestmove: result.bestmove,
  };
}

function parseInfo(line) {
  const depth = Number(line.match(/\bdepth (\d+)/)?.[1] || 0);
  const score = line.match(/\bscore (cp|mate) (-?\d+)/);
  if (!score) return null;
  const pvText = line.match(/\bpv (.+)$/)?.[1] || "";
  return {
    depth,
    cp: score[1] === "cp" ? Number(score[2]) : null,
    mate: score[1] === "mate" ? Number(score[2]) : null,
    pv: pvText.split(/\s+/).filter(Boolean),
  };
}

export function createEngine(id = browserDescriptor.id, options = {}) {
  const descriptor = engineDescriptor(id);
  if (descriptor.id === browserDescriptor.id) return new BrowserStockfish(options);
  if (descriptor.id === recklessBrowserDescriptor.id) return new BrowserReckless(options);
  return new RemoteEngine(descriptor, options);
}
