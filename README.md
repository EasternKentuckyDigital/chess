# DoBackChess

DoBackChess is a focused, static browser chess tool with three product surfaces:

1. **Play engines** — play Stockfish 18 or Reckless from the normal position or
   with knight, rook, or queen odds for either side.
2. **Analysis board** — import one PGN, load a FEN, or build a position without
   changing the existing board workflow. A full-game review measures accuracy,
   finds missed motifs, and creates practice positions.
3. **Review games** — import 20, 35, or 50 Chess.com, Lichess, or PGN games,
   summarize accuracy, find recurring missed tactics, practice positions from
   those games, and open matching tagged puzzle themes on Lichess.

PGN parsing, legal move handling, Stockfish search, puzzle creation, review
scheduling, and the TypeScript `chess_detect` tactic classifier all run in the
visitor's browser. Reckless remains alpha software and may download about 61.5
MiB when first used.

## Run it locally

```bash
git clone https://github.com/EasternKentuckyDigital/chess.git
cd chess
chmod +x run.sh
./run.sh
```

Open <http://localhost:47831>. The local command only serves files; it does not
install packages, create a database, or run application code on the server.

To select a different port or allow access from a trusted local network:

```bash
REPLAY_PORT=47832 ./run.sh
REPLAY_HOST=all ./run.sh
```

Do not expose this development server directly to the public internet.

## Deploy to GitHub Pages

The included `.github/workflows/pages.yml` compiles and verifies the classifier,
then publishes `static/`. It runs on pull requests for validation, deploys on
pushes to `main`, and still supports manual `workflow_dispatch` runs. Choose **GitHub
Actions** in the repository's **Settings → Pages** before the first deployment.

All application and asset URLs are relative. `static/CNAME` declares
`dobackchess.com` for the production GitHub Pages deployment; the domain's DNS
must point at GitHub Pages before HTTPS can be enabled.

## Static-first architecture

- `static/lib/game-import.js` calls the official public Chess.com and Lichess
  APIs serially, parses PGN with the vendored `chess.js`, and builds the replay
  frames previously produced by Python.
- `static/lib/engine-providers.js` exposes one analysis contract. Stockfish and
  Reckless run in Web Workers; configured Lc0 cloud or Reckless cloud services
  use the same contract without sharing IDs with the local engines.
- `static/lib/brilliancy.js` identifies material offers—including discovered
  sacrifices—and leaves the final classification to constrained engine search.
- `static/lib/analysis-board.js` provides click and drag legal play, PGN import,
  clickable notation history, position editing, FEN loading, arrows, live
  analysis, explicit queen/rook/bishop/knight promotion, and progressive
  per-game accuracy through the selected engine provider, missed-motif review,
  Lichess theme recommendations, and conversion of important mistakes into the
  existing puzzle trainer.
- `src/chess-detect.ts` is the typed, browser-safe port of the pinned MIT
  `aslyamov/chess_detect` tactical detectors. The checked-in build at
  `static/lib/chess-detect.js` classifies ten concrete themes, produces readable
  explanations, and maps only supported themes to exact Lichess training URLs.
- `static/lib/board-arrows.js` provides reusable right-drag board annotations for
  both training puzzles and the general analysis board.
- `static/lib/profile-store.js` replaces misleading server-local passwords with
  explicit device profiles. Preferences, cached analysis, and review schedules
  remain separate per profile in the browser.
- `static/lib/auth-sync.js` adds optional remembered Google and email/password
  sign-in through Firebase, supports password reset and Google account linking,
  and syncs saved games, preferences, reports, and review schedules through
  Firestore. Google falls back to redirect sign-in when a browser blocks the
  provider popup.
- `static/lib/engine-play.js` provides a playable Stockfish/Reckless board with
  standard starts plus knight, rook, and queen odds for either side, including
  an explicit promotion-piece choice that defaults to queen.
- `static/lib/chess-report.js` powers the unified 20–50 game review. Stockfish
  measures loss and accuracy; `chess_detect` labels the best move at each
  reportable mistake; the result includes aggregate Lichess recommendations and
  a bounded own-game puzzle deck.
- `static/lib/game-import.js` accepts Chess.com, Lichess, multi-game PGN files,
  and pasted SAN move notation for training decks and chess reports.
- `static/config.js` contains public deployment configuration. Never put engine
  provider keys or other secrets there.

The static app is complete without a backend. Cross-device state uses optional
Firebase Authentication and Firestore. The free beta exposes only the two
fully local browser engines, so no billing or engine gateway is required. Setup
and future API boundaries are documented in
[`docs/architecture.md`](docs/architecture.md).

## Configure cloud accounts

Create a Firebase web app, enable Google and Email/Password providers, keep the
Authentication setting at **one account per email address**, create Firestore,
and deploy [`firestore.rules`](firestore.rules). Add the public web configuration
to `static/config.js`:

```js
firebase: {
  apiKey: "...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  appId: "...",
},
```

Authorize the GitHub Pages domain in Firebase Authentication. Add `localhost`
as an authorized domain while testing with `./run.sh`. The SDK uses local auth
persistence so an account is remembered after the browser restarts; blocked
Google popups continue through Firebase's redirect flow instead.

## Included Reckless browser assets

The complete Reckless alpha browser package—including its worker, JavaScript
wrapper, AGPL notices, rebuild information, and all four generated WASM
chunks—is committed under `static/vendor/reckless/` on `main`. No engine build
or asset installation is required after cloning. The browser downloads the
roughly 61.5 MiB package only after a visitor explicitly starts Reckless.

`scripts/install-reckless.sh` is retained only for maintainers replacing the
vendored package with a newly verified RecklessWeb build.

## chess_detect TypeScript port

The primary tactic classifier is a TypeScript port of
[`aslyamov/chess_detect`](https://github.com/aslyamov/chess_detect), pinned to
commit `662ad8d64f59a4bbc83cc003585f9bf10f4b7a70`. It covers double checks, forks,
discovered checks, pins, skewers, trapped pieces, hanging captures, material and
mate defender removal, and exploiting an existing pin. The port uses the
site's existing `chess.js` rules engine, needs no Python service or runtime, and
fails closed on invalid positions or illegal engine moves.

The upstream MIT notice and exact provenance are in
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md). To rebuild and verify the
checked-in browser module:

```bash
pnpm install --frozen-lockfile
pnpm run check:classifier
pnpm run build:classifier
node --test tests/chess-detect.test.mjs
```

## How training works

- Review imports and analyzes the latest 20 games by default and can be set to
  35 or 50 directly on the page. If an account has fewer games, DoBackChess uses
  everything available and says so explicitly. Missing usernames and accounts
  with no usable public games are separate error states.
- Signed-in Google and email/password accounts retain a substantially larger
  deduplicated imported-game library through Firebase than guest/device
  sessions. Records are capped by count and serialized size to stay below
  Firestore document limits, and new imports take priority over older games.
- Free analysis uses Stockfish 18 or Reckless in the visitor's browser. The
  Reckless browser build is alpha software; it may need to download about 61.5
  MiB the first time it is initialized and remains entirely local. Settings
  offer Super quick (depth 16 / 400,000 nodes), Quick (depth 17 / 550,000 nodes),
  Balanced (depth 18 / 750,000 nodes), and Deep (depth 22 / 2,000,000 nodes).
  Super quick is the default because it is the release-tested quality baseline.
  Every browser feature is available in the free beta; there is no paid tier or
  upgrade prompt.
- A position becomes a puzzle when the played move loses at least three pawns,
  misses a forced mate, or misses a clearly winning position.
- Puzzles are added to the deck after each game finishes; training can begin
  as soon as the first qualifying position is found within a game. Games are
  processed one at a time while the remaining selected games continue in the
  background.
- Again, Hard, Good, and Easy grades control when a puzzle returns.
- Pieces support click-to-move and pointer-based drag-and-drop for mouse, pen,
  and touch.
- Right-drag across either board to draw or remove an arrow. Shift-drag provides
  the same action for devices where a secondary-button drag is unavailable.
- Analysis results are cached in the browser by account, source, player, game,
  engine, and analysis version.

## Free beta

The beta has no pricing, subscriptions, feature locks, or upgrade prompts.
Public-game and PGN import, Stockfish 18, Reckless browser alpha, the analysis
board, 20–50 game review, Lichess recommendations, review scheduling, and cached
local decks are all available. Both engines run on the visitor's device;
Reckless may require a large first-use download and both engines can increase
CPU, memory, battery, and mobile-data use.

DoBackChess is currently a public alpha developed by
[Eastern Kentucky Digital](https://easternkentuckydigital.com). Planned work
includes Lc0 analysis, opening study, endgame study, deeper game-history tools,
and more training formats.

## Browser and mobile support

DoBackChess is designed for current evergreen browsers:

| Browser | Support target | Notes |
| --- | --- | --- |
| Chrome / Edge | Current and previous two major versions | Best target for module workers, WebAssembly SIMD, and large local engine assets. |
| Firefox | Current and previous two major versions | Module workers and WebAssembly SIMD supported. |
| Safari / iOS Safari | 16.4+ | Older Safari builds are the highest-risk target for module-worker and WASM SIMD behavior. |
| Mobile browsers | Current iOS Safari and Android Chrome | Layouts are touch-friendly, but Reckless's 61.5 MiB download and memory/battery load may be impractical on constrained devices. |

If either browser engine cannot start, DoBackChess shows the worker, download, or
unsupported-browser failure instead of silently falling back to empty analysis.

## Lichess engine and report benchmark

> **Historical benchmark note:** checked-in motif precision and “Tactics
> Report” agreement numbers below describe the previous independent
> `tactical-themes.js` classifier. The focused product now uses
> `chess_detect` for user-facing motif detection. The engine legality,
> constrained-search, score-perspective, and only-move results remain relevant;
> the old motif-label percentages are not release claims for the new analyzer.

`scripts/benchmark-lichess.mjs` runs a deterministic, side-balanced benchmark
against the official CC0 Lichess position-evaluation and puzzle exports. By
default it checks 1,000 evaluation positions and 1,000 tactical puzzles with
both validated baseline engines (Stockfish depth 16 and Reckless at 400,000
nodes), then replays up to 1,000 puzzle-origin blunders through the same
constrained-search logic used by Tactics Report.

The runner reports legal-move rate, agreement with Lichess's deep top move and
available MultiPV choices, decisive score-sign agreement, puzzle only-move
solve rate, results split by side to move, explicit Black-to-move
White-maximization trap counts, report detection rate, end-to-end agreement with
Lichess's tactical reply, and precision/coverage for named motifs. Lichess
evaluations are White-perspective; DoBackChess engine results are UCI side-to-move
perspective. The runner converts between them explicitly.

The held-out 1,000-position release cohort at offset 10,000 produced 95.8%
end-to-end Tactics Report agreement, 99.69% precision for concrete report labels,
99.1% Stockfish puzzle solves, and 99.7% Reckless puzzle solves. Concrete report
labels intentionally cover 33.13% of detected cases; ambiguous positions are
shown as **Forcing calculation** instead of receiving a low-confidence motif.
That held-out baseline is now the default **Super quick** setting. **Quick** uses
depth 17 and 550,000 Reckless nodes, **Balanced** uses depth 18 and 750,000
nodes, and **Deep** uses depth 22 and 2,000,000 nodes. The report loss cutoff
remains 0.8 pawns. Exact top-move
agreement is not expected to reach 100% because a shallow browser search can
choose a strategically equivalent move outside the available Lichess MultiPV.

The checked-in `lichess-level-*` results are smaller exploratory strength and
timing cohorts from the same leading-file sample. They are useful smoke tests,
not replacements for the held-out 1,000-case release gate. All tested levels
returned legal moves for every tested position, and the deeper levels took
materially longer, which is why the Settings UI warns about CPU, battery, and
wait time before a visitor selects them.

A fresh 50-position held-out rerun for the default Super quick setting returned
100% legal moves from both engines, 98% Stockfish and 100% Reckless puzzle solves,
96% aggregate end-to-end Tactics Report agreement, and 100% precision for named
report motifs. Its 25-position White-side report slice measured 92%, illustrating
why the larger 1,000-case release gate above remains the quality reference.

| Setting | Stockfish / Reckless limit | Sample per phase | Stockfish MultiPV / puzzle | Reckless MultiPV / puzzle | Wall time on test machine |
| --- | --- | ---: | ---: | ---: | ---: |
| Super quick | depth 16 / 400,000 nodes | 50 | 98% / 100% | 98% / 98% | 46.20 s |
| Quick | depth 17 / 550,000 nodes | 25 | 96% / 100% | 92% / 100% | Device-dependent |
| Balanced | depth 18 / 750,000 nodes | 50 | 96% / 98% | 98% / 100% | 111.47 s |
| Deep | depth 22 / 2,000,000 nodes | 25 | 100% / 96% | 100% / 96% | 266.50 s |

“MultiPV” is agreement with one of Lichess's available deep candidate moves;
“puzzle” is exact agreement on its engine-validated only move. The Deep cohort
is half-sized and its percentages are correspondingly noisy. Timing includes
both engines across evaluation and puzzle phases and is a relative local
measurement, not a promise for other devices. Raw results are checked in as
`benchmarks/lichess-level-*-2026-07-*.json`.

The report release gate is also enforced separately by blundering side. The
held-out result is 96.6% for White and 95.0% for Black, preventing an aggregate
score from hiding a side-to-move reversal regression.

Lichess documents that its puzzle export is engine-validated and automatically
tagged. DoBackChess uses the export and public theme definitions as test references,
but its line-aware classifier is an independent implementation. No code was
copied from `lichess-puzzler`, whose source is AGPL-3.0; this preserves DoBackChess's
separate repository license while still making the comparison reproducible.

Download a small leading byte range instead of the 21 GB evaluation export:

```bash
curl --fail --location --range 0-16777215 \
  --output /tmp/lichess-eval-prefix.zst \
  https://database.lichess.org/lichess_db_eval.jsonl.zst
curl --fail --location --range 0-4194303 \
  --output /tmp/lichess-puzzle-prefix.zst \
  https://database.lichess.org/lichess_db_puzzle.csv.zst
node scripts/benchmark-lichess.mjs \
  --eval /tmp/lichess-eval-prefix.zst \
  --puzzles /tmp/lichess-puzzle-prefix.zst \
  --output /tmp/replay-lichess-benchmark.json
```

The input can also be the complete `.zst` exports. Decompression is streamed,
and reading stops as soon as the balanced cohort is full; the runner does not
load either source database into memory.

The checked-in release baseline is `benchmarks/lichess-release-2026-07-19.json`.
Functional failures cover crashes, missing/illegal moves, and evidence of the
Black-side reversal bug. Quality warnings separately flag strength or labeling
metrics that deserve product work without misreporting a deep-search move
disagreement as an engine integration failure.

## Browser Reckless integration

The browser Reckless integration is currently alpha software. Visitors should
expect a possible 61.5 MiB download when they start Reckless analysis for the
first time, along with higher memory, battery, and mobile-data use than
Stockfish's lite browser build.

The local provider is `reckless-browser`. Any configured remote gateways remain
hidden and unavailable during the free beta. Selecting the provider does not fetch the engine. Initialization
starts only when the user explicitly begins analysis, at which point download
progress is shown. All package files live in `static/vendor/reckless/`, and the
wrapper resolves the worker, glue, and WASM chunks with `new URL(...,
import.meta.url)`. No URL begins with `/`, so the same files work at a custom
domain root and beneath `/chessreplaystatic/` on GitHub Pages.

DoBackChess gives browser Reckless a fixed node budget for each analysis level
rather than assuming that its depth means the same cost or strength as
Stockfish. The Balanced node budget is publicly configurable at
`replayConfig.browserReckless.nodes`; the selected level and effective budget
are part of the engine cache fingerprint.

Constrained `searchMoves` are genuinely supported. The pinned Reckless root
move list is filtered before search by the distributed WASM patch, and the
worker rejects any returned move outside the requested set. It never substitutes
an unrestricted principal variation. Search replacement terminates the
synchronous worker, rejects the old promise as an expected `AbortError`, restores
the last confirmed position, and ignores messages from stale worker generations.

### Update or rebuild the vendored engine

The vendored browser package is based on
`EasternKentuckyDigital/recklesschessweb` commit
`a64199fbd26251914120a8fa6d08c89fa3ac50d6`. The engine is based on upstream
Reckless commit `a6fa482c7d46fb81831573f10be396f20a5efdb5` with the exact
`static/vendor/reckless/RECKLESS-SEARCHMOVES.patch` applied.

1. Check out those commits and apply the patch from the Reckless checkout.
2. Run RecklessWeb's `scripts/build-reckless-wasm.sh /path/to/Reckless` with
   Rust, `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.123 installed.
3. Carry the `searchMoves` worker/wrapper support forward, run
   `node scripts/build-package.mjs`, and copy the complete `dist/` directory to
   `static/vendor/reckless/`.
4. Update the pinned commits, compiled SHA-256, version, package size, and DoBackChess
   cache fingerprint; then run the Node tests and real browser smoke test.

## Configure remote engines

This section applies only to the optional remote `lc0` and `reckless` providers,
not `reckless-browser`. Set an HTTPS endpoint in `static/config.js`. A configured
endpoint receives:

```json
{
  "fen": "position in FEN notation",
  "searchMoves": ["optional", "uci", "moves"],
  "limit": { "depth": 12 }
}
```

It returns a UCI-style result:

```json
{
  "bestmove": "e2e4",
  "depth": 12,
  "cp": 34,
  "mate": null,
  "pv": ["e2e4", "e7e5"]
}
```

`cp` and `mate` use the normal UCI side-to-move perspective so constrained
`searchMoves` evaluations can be compared with the unrestricted best move.

The endpoint must enforce authentication, entitlement, quotas, and billing. It
should return a short-lived access token through the account flow; DoBackChess reads
that token from `sessionStorage` under `replay:engine-access-token`.

## Open-source components

- Chess rules and PGN parsing: `chess.js` 1.4.0, BSD-2-Clause.
- Browser engine: Stockfish.js 18, GPLv3. Its license is included at
  `static/vendor/stockfish/COPYING.txt`.
- Browser engine package: [Reckless Browser](https://github.com/EasternKentuckyDigital/recklesschessweb)
  0.1.0, based on [Reckless](https://github.com/codedeliveryservice/Reckless)
  0.10.0-dev, AGPL-3.0-only. The full license, provenance, exact source patch,
  generated glue, type files, worker, and split WASM are included at
  `static/vendor/reckless/`. Corresponding source and rebuild directions are in
  `static/vendor/reckless/SOURCE.md` and this README.
- Tactic classifier: TypeScript port of
  [aslyamov/chess_detect](https://github.com/aslyamov/chess_detect), pinned at
  commit `662ad8d64f59a4bbc83cc003585f9bf10f4b7a70` under the MIT License. The full
  notice and provenance are in `THIRD_PARTY_LICENSES.md`.
- Piece artwork: Cburnett, Alpha, and Merida sets from Lichess. The Lichess
  license is included at `static/pieces/LICHESS-LICENSE.txt`.
- Future optional engine gateway: Lc0 source is available at
  <https://github.com/LeelaChessZero/lc0> under GPL-3.0-or-later.
- Future optional engine gateway: Reckless source is available at
  <https://github.com/codedeliveryservice/Reckless> under AGPL-3.0.

## DoBackChess license

DoBackChess's original website and application code is source-available under the
custom [`LICENSE`](LICENSE): personal, non-commercial use of unmodified copies is
allowed; modification, redistribution, and commercial use require separate
permission. This is not an OSI open-source license.
