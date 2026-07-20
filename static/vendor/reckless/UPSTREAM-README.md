# Reckless Browser

`@eastern-kentucky-digital/reckless-browser` is a framework-independent browser
package for the real [Reckless chess engine](https://github.com/codedeliveryservice/Reckless).
It provides both a promise-based JavaScript API and a Stockfish-style UCI Web
Worker. Search and evaluation run locally; positions and game data are never
sent to a server.

The React/Next.js application in this repository is only a demo. The engine
package has no React, Next.js, Node.js, or server runtime dependency.

## Architecture

The browser port has three layers:

1. The upstream Rust engine compiled to single-threaded SIMD WebAssembly with
   wasm-bindgen glue.
2. `reckless-worker.js`, a module Web Worker supporting structured requests and
   familiar UCI strings.
3. `reckless-engine.js`, a request-ID-based wrapper with promises, live output,
   download progress, stale-result protection, and worker-restart cancellation.

The build produces a directly copyable directory:

```text
dist/
  reckless-engine.js
  reckless-engine.d.ts
  reckless-worker.js
  reckless.js
  reckless.d.ts
  reckless_bg.wasm.d.ts
  reckless_bg.wasm.part0
  reckless_bg.wasm.part1
  reckless_bg.wasm.part2
  reckless_bg.wasm.part3
  react/
    use-reckless-engine.js
    use-reckless-engine.d.ts
  SOURCE.md
  LICENSE
```

## JavaScript API

Copy `dist/` into a static directory in the consuming site. Keep the worker,
glue, and WASM chunks together.

```js
import { RecklessEngine } from "/engines/reckless/reckless-engine.js";

const engine = new RecklessEngine({
  assetBaseUrl: "/engines/reckless/",
});

engine.onInfo((info) => {
  console.log(info.depth, info.scoreCp, info.mate, info.pv);
});

engine.onOutput((line) => console.log(line));

await engine.init();

const result = await engine.analyze({
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  nodes: 50000,
  multiPv: 3,
  searchMoves: ["e2e4", "d2d4"],
});

console.log(result.bestMove, result.lines);
engine.terminate();
```

`RecklessEngine` exposes:

- `init()`
- `setPosition(fen)`
- `makeMove(uciMove)`
- `analyze({ fen?, movetime?, depth?, nodes?, multiPv?, searchMoves? })`
- `stop()`
- `newGame()`
- `getFen()`
- `terminate()`
- `onInfo(callback)`
- `onOutput(callback)`
- `onDownloadProgress(callback)`

Each callback registration returns an unsubscribe function. Illegal moves and
invalid FENs reject with an error whose `code` is `ILLEGAL_MOVE` or
`INVALID_FEN`.

If multiple search limits are provided, nodes takes precedence over depth;
depth takes precedence over movetime. With no limit, analysis defaults to 1000
milliseconds. `multiPv` is clamped to 1–10.

### Asset locations

`assetBaseUrl` can be root-relative, page-relative, or absolute:

```js
new RecklessEngine({ assetBaseUrl: "/reckless/" });
new RecklessEngine({ assetBaseUrl: "./vendor/reckless/" });
new RecklessEngine({
  assetBaseUrl: "https://cdn.example.com/reckless/0.1.0/",
  workerUrl: "/workers/reckless-worker.js",
});
```

This works at a domain root, in a subdirectory, on GitHub Pages or Cloudflare
Pages, and inside another application such as ChessReplay. Cross-origin glue
and WASM assets require normal CORS headers. Hosting a worker script on a
different origin may also be restricted by the browser, so keeping the worker
same-origin is the most portable setup.

The distributed build uses four chunks smaller than 25 MiB. A host that permits
a single 61.5 MiB file may concatenate the chunks byte-for-byte and select it:

```js
new RecklessEngine({
  assetBaseUrl: "/reckless/",
  wasmFile: "reckless_bg.wasm",
});
```

Missing glue, missing chunks, HTTP errors, and invalid combined WASM bytes
produce explicit initialization errors containing the failing asset URL.

## Worker-only UCI interface

When all assets are colocated, use the worker directly:

```js
const worker = new Worker("/reckless/reckless-worker.js", { type: "module" });

worker.onmessage = ({ data }) => console.log(data);
worker.postMessage("uci");
worker.postMessage("isready");
worker.postMessage("position startpos moves e2e4 e7e5");
worker.postMessage("setoption name MultiPV value 3");
worker.postMessage("go movetime 1000");
```

Supported commands:

```text
uci
isready
ucinewgame
position startpos
position startpos moves e2e4 e7e5
position fen <six-field FEN>
position fen <six-field FEN> moves ...
go movetime <milliseconds>
go depth <depth>
go nodes <nodes>
go nodes <nodes> searchmoves <uci move> [<uci move> ...]
setoption name MultiPV value <1-10>
stop
quit
```

Typical output:

```text
id name Reckless 0.10.0-dev
uciok
readyok
info depth 12 score cp 34 nodes 100000 nps 250000 pv e2e4 e7e5
bestmove e2e4
```

The worker also accepts the request-ID structured protocol used by the wrapper.
Send an `init` object before UCI commands to configure a non-colocated asset
directory:

```js
worker.postMessage({
  type: "init",
  requestId: "init-1",
  assetBaseUrl: "https://cdn.example.com/reckless/0.1.0/",
});
```

## Search cancellation and stale results

The ChessReplay build extends the pinned WASM API with a genuine root-move
filter. `searchMoves` and UCI `searchmoves` restrict the engine's root move list
before search; the wrapper verifies that the returned best move is in the
requested set. Builds without that API fail with `UNSUPPORTED_SEARCH_MOVES`
instead of silently returning unrestricted analysis.

The pinned Reckless WASM API performs search synchronously inside its worker and
does not expose a real interruption flag. Because that worker cannot process a
queued `stop` message until search has already finished, raw UCI `stop` is
non-preemptive.

`RecklessEngine.stop()` provides safe cancellation by terminating the blocked
worker, starting a fresh worker, and restoring the last confirmed FEN. Pending
promises reject with `AbortError`. Every structured operation uses a unique
request ID, and messages from replaced workers are ignored. Calling `analyze()`
again automatically supersedes an older analysis, so an old position cannot
overwrite a newer ChessReplay selection.

## ChessReplay integration

1. Run `pnpm run build` in this repository.
2. Copy everything from `dist/` to ChessReplay's
   `public/engines/reckless/` directory.
3. Initialize one `RecklessEngine` for the analysis panel with
   `assetBaseUrl: "/engines/reckless/"`.
4. Subscribe to `onInfo` once and map `multiPv`, `depth`, `scoreCp`, `mate`, and
   `pv` into the analysis UI.
5. Call `analyze({ fen, nodes, multiPv, searchMoves })` when a game position is selected.
6. Call `stop()` before switching positions; treat `AbortError` as expected.
7. Call `terminate()` when the panel or page unmounts.

Complete examples are in [`examples/chessreplay`](examples/chessreplay):

- [`plain-javascript.js`](examples/chessreplay/plain-javascript.js)
- [`react-example.tsx`](examples/chessreplay/react-example.tsx)
- the optional `useRecklessEngine` adapter exported from the package's `/react`
  subpath

The core package does not import React. React is an optional peer used only by
the adapter.

## Build and verify

Requirements for the JavaScript package and demo:

- Node.js 22.13 or newer
- pnpm 11.9 or newer

Exact commands:

```bash
pnpm install
pnpm run build          # standalone dist/ and demo static assets
pnpm test               # package, worker, real WASM, and demo tests
pnpm run typecheck
pnpm run lint
pnpm run verify         # all of the above, including the demo production build
```

Run the standalone browser smoke fixture:

```bash
pnpm run build
pnpm run test:browser:serve
```

Then open `http://127.0.0.1:4173/tests/browser-smoke/`. It imports only the
contents of `dist/`, receives live `info` output, and reports a legal
`bestmove`; it does not load the React demo.

The demo remains available for development:

```bash
pnpm run dev
```

`pnpm run build:demo` writes the demo production output to `.demo-dist/` and
restores the standalone package to `dist/`.

## Rebuild the Rust engine

The base engine is pinned to upstream commit
`a6fa482c7d46fb81831573f10be396f20a5efdb5` (`0.10.0-dev`). ChessReplay adds
the root-move filtering patch documented in `SOURCE.md`. Rebuilding
requires Rust, `wasm32-unknown-unknown`, `wasm-bindgen-cli` 0.2.123, Git, and a
SIMD-capable browser target.

```bash
pnpm run engine:build -- /path/to/Reckless
pnpm run build
```

With no path, the script clones the pinned upstream commit:

```bash
pnpm run engine:build
pnpm run build
```

The generated `.wasm.part*` files are intentionally excluded from Git because
of their combined size. The package build fails with a clear instruction when
they are absent.

## Browser and performance notes

- Requires WebAssembly, WebAssembly SIMD, ES modules, module Web Workers,
  `fetch`, and modern Promise APIs.
- Current Chrome, Edge, Firefox, and Safari releases with those features are
  suitable; older browsers without SIMD or module-worker support are not.
- The engine download is approximately 61.5 MiB before HTTP compression. First
  initialization downloads all chunks, concatenates them in the worker, and
  initializes Reckless's NNUE data. Subsequent loads can use the browser cache.
- The default build is single-threaded and does not require cross-origin
  isolation. It is slower than native multi-thread Reckless.
- Mobile browsers can run the engine, but startup, memory use, thermal limits,
  and battery impact are materially higher than on desktop. Use shorter search
  limits and cancel analysis when the view is hidden.
- Search never blocks the page's main thread. It does synchronously occupy the
  dedicated engine worker until completion or termination.
- Scores are the raw UCI score from the side-to-move search perspective. A UI
  that always displays White's perspective should invert scores when Black is
  to move.

## License and provenance

Reckless is licensed under the GNU Affero General Public License v3.0. This
repository and browser integration are distributed under `AGPL-3.0-only`; see
[`LICENSE`](LICENSE) and [`public/engine/SOURCE.md`](public/engine/SOURCE.md).

When you deploy a modified version for users over a network, AGPLv3 generally
requires offering the corresponding source for that deployed version. Preserve
the Reckless attribution, license notice, source offer, and pinned upstream
provenance. This README is technical guidance, not legal advice.
