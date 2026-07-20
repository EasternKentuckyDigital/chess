import assert from "node:assert/strict";
import test from "node:test";
import { createRecklessWorkerRuntime } from "../static/vendor/reckless/reckless-worker.js";

function scope() {
  const listeners = new Map();
  return {
    messages: [],
    postMessage(message) { this.messages.push(message); },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
  };
}

function wasmResponse() {
  return new Response(new Uint8Array([0, 97, 115, 109]), {
    status: 200,
    headers: { "content-length": "4" },
  });
}

test("a missing WASM chunk reports its exact URL and status", async () => {
  const workerScope = scope();
  const runtime = createRecklessWorkerRuntime(workerScope, {
    async fetch(url) {
      if (String(url).endsWith("part2")) return new Response(null, { status: 404, statusText: "Not Found" });
      return wasmResponse();
    },
  });
  await assert.rejects(
    runtime.handleMessage({ type: "init", requestId: "init-1", assetBaseUrl: "https://example.test/chessreplaystatic/vendor/reckless/" }),
    (error) => error.code === "ASSET_LOAD_ERROR" && /part2.*404 Not Found/.test(error.message),
  );
});

test("a WebAssembly SIMD compile failure becomes an unsupported-browser error", async () => {
  const workerScope = scope();
  const runtime = createRecklessWorkerRuntime(workerScope, {
    async fetch() { return wasmResponse(); },
    async importModule() {
      return {
        default: async () => {
          const error = new Error("WebAssembly SIMD opcode unavailable");
          error.name = "CompileError";
          throw error;
        },
        Engine: class {},
      };
    },
  });
  await assert.rejects(
    runtime.handleMessage({ type: "init", requestId: "init-1" }),
    (error) => error.code === "UNSUPPORTED_BROWSER" && /current browser/.test(error.message),
  );
});
