# DoBackChess static architecture

DoBackChess is a fully static analysis application with optional Firebase sync.
Its visible product is deliberately limited to three routes: Play engines,
Analysis board, and Review games. GitHub Pages can own the complete free-beta
application. Future server-side engine gateways are documented separately but
are not exposed in the beta UI.

## Static application

The browser imports public games directly from Chess.com and Lichess, parses
PGN with `chess.js`, evaluates positions with local Stockfish or Reckless,
labels missed moves with the TypeScript `chess_detect` classifier, builds
puzzles, renders the board, and schedules reviews. Device profiles are intentionally described as device-only;
they are not password accounts and do not imply cross-device durability.

Browser storage is appropriate for the analysis cache, UI preferences, and an
offline/device profile. It is not the authority for a cross-device identity.
During the free beta, only the local Stockfish and Reckless providers are shown;
there are no pricing controls, entitlements, or upgrade prompts.

## Cloud accounts and sync

The static application includes an optional Firebase Authentication and Cloud
Firestore adapter. Google and Email/Password are the supported identity
providers. Firebase must be configured for **one account per email address**.
An email/password user can sign in first and link Google from Settings so both
methods resolve to the same Firebase UID.

DoBackChess stores only user-owned state below `users/{uid}/state/{stateId}`:

- preferences;
- imported game libraries and played-engine games;
- spaced-repetition schedules and puzzle-solving status; and
- generated 20–50 game review summaries, motif recommendations, and puzzle decks.

Imported libraries merge new records ahead of older records and deduplicate by
game ID. Cloud accounts may retain up to 500 records per player/source, while
guest and device libraries retain up to 100. A conservative serialized-byte
budget keeps each state document below Firestore's document-size ceiling.

Review analyzes the latest 20 games by default and can be set to 35 or 50 on the
Review page. Single-game analysis accepts PGN, FEN, and positions built on the
existing board. Both paths use the same puzzle threshold and Lichess-theme
mapping.

Deploy [`firestore.rules`](../firestore.rules) with the Firebase CLI so each UID
can read and write only its own state. Firebase web configuration values are
public identifiers, not secrets. Google OAuth credentials remain managed by
Firebase and must not be committed.

If Firebase is not configured, DoBackChess keeps the existing guest and device
profile behavior. The following API design remains an alternative for teams
that do not want Firebase.

## Optional custom account and sync API

Use a hosted identity provider plus a durable database (for example, a small
edge worker with managed SQL). Avoid inventing another password database inside
the static app. The service should expose these logical operations:

| Operation | Purpose |
| --- | --- |
| `GET /v1/session` | Return the current user and engine entitlements. |
| `GET /v1/state` | Return the user's preferences and review schedule. |
| `PUT /v1/state` | Upsert versioned preferences and review cards. |
| `POST /v1/engine-token` | Mint a short-lived token scoped to one engine and quota. |

Every state row should include `user_id`, a stable state key, a version or
updated timestamp, and JSON data. Resolve concurrent updates per review card,
not by replacing an entire user's state with the last device to write.

For a GitHub Pages origin, prefer an OAuth/OIDC authorization-code flow with
PKCE. Keep long-lived sessions in secure, HTTP-only cookies when the chosen
domain layout permits it. Engine tokens should be short lived and narrowly
scoped even when the account session is longer lived.

### Free-beta engine policy

Users may import their own public games or PGNs, run Stockfish or Reckless in
the browser, review locally cached decks, and sync preferences and progress.
Remote engine descriptors remain reserved for future development but are
filtered out of the product UI and cannot be selected in this beta.

## Optional compute gateway

The browser's `RemoteEngine` sends a position to a configured HTTPS endpoint.
That gateway should:

1. Verify the short-lived DoBackChess token.
2. Check the user's entitlement and remaining credits.
3. Validate FEN, optional `searchMoves`, and bounded analysis limits.
4. Queue work for Lc0 or Reckless without exposing provider credentials.
5. Atomically debit metered usage and return a normalized UCI-style result.

The response contract is shared by every engine:

```ts
type EngineResult = {
  bestmove: string;
  depth: number;
  cp: number | null;
  mate: number | null;
  pv: string[];
};
```

Centipawn and mate scores use the UCI side-to-move perspective. The gateway
must preserve that perspective for both unrestricted and `searchMoves` calls.

Returning this small contract keeps puzzle generation independent from any
specific vendor. A future asynchronous gateway can add a job resource while
preserving the same final result shape.

## Local Reckless provider

The browser provider is an alpha feature. Its UI must disclose that status and
the possible 61.5 MiB first-use download before a visitor starts analysis.

`BrowserReckless` adapts the vendored `RecklessEngine` package to the same
`init()`, `evaluate(fen, searchMoves)`, and `close()` contract as Stockfish. The
adapter dynamically imports the small package wrapper, and neither that wrapper,
its worker, nor 61.5 MiB of WASM chunks are fetched until Reckless analysis is
explicitly started. It is a free local provider with ID `reckless-browser`;
the reserved hosted provider keeps the ID `reckless`.

Assets are colocated in `static/vendor/reckless/`. Both the worker URL and asset
base are derived from `import.meta.url`, which preserves the GitHub Pages project
prefix and also works at a custom-domain root. The worker streams all four
chunks, reports combined progress, reassembles the bytes, and instantiates the
single-threaded SIMD build.

The beta exposes four explicit local-search budgets: Super quick uses Stockfish
depth 16 and 400,000 Reckless nodes, Quick uses depth 17 and 550,000 nodes,
Balanced uses depth 18 and 750,000 nodes, and Deep uses depth 22 and 2,000,000
nodes. Super quick is the release-tested default. The selected
level and effective limit are included in the cache fingerprint. `searchMoves`
is implemented as an actual root-move filter in the pinned Rust/WASM build. The
worker also verifies the best move against the requested set and raises a
capability error if a future WASM build omits the filtering API.

Reckless search is synchronous inside its worker. Replacement and cancellation
therefore terminate the old worker, reject pending requests with `AbortError`,
create a fresh worker, restore the last confirmed FEN, and discard messages from
old worker generations. View-level position tokens add a second stale-result
guard before UI state is updated.

## Browser play engines

Stockfish and the alpha Reckless browser package are both vendored on `main`.
The Play page uses Stockfish directly and exposes Reckless through the same
framework-free `RecklessEngine` adapter in `static/vendor/reckless/`. No
post-clone download or build step is required for the repository; a visitor's
browser may download the roughly 61.5 MiB Reckless package when that engine is
first selected. `scripts/install-reckless.sh` exists only for maintainers
replacing the pinned package with a newly verified build.

## Review and tactical classification

Both review paths compare Stockfish's unconstrained best result with a
constrained search of the move actually played. Both results remain in UCI
side-to-move perspective. A loss of at least 80 centipawns is reportable; the
existing stricter puzzle rule still requires a three-pawn loss, missed forced
mate, or missed clearly winning position.

`src/chess-detect.ts` ports the ten tactical detectors from MIT-licensed
`aslyamov/chess_detect` at commit
`662ad8d64f59a4bbc83cc003585f9bf10f4b7a70`. The generated
`static/lib/chess-detect.js` receives the pre-move FEN, Stockfish's legal best
move, and previous-move capture context. It returns material-aware theme IDs and
phrases while rejecting malformed or illegal inputs. Previous-move context
prevents ordinary recaptures from being mislabeled as hanging-piece wins.

Only themes with a direct Lichess training equivalent become recommendation
links. Own-game puzzles retain the full theme list and readable tagline. Batch
recommendations rank repeated themes first, then total missed evaluation
impact. The classifier runs entirely in the browser and needs no Python runtime
or WASM download. Its MIT notice and provenance are in
`THIRD_PARTY_LICENSES.md`.

## Security boundary

Everything below `static/` is public. Do not place database credentials,
provider API keys, signing secrets, price rules, or trusted credit balances in
that directory. CORS is access control for browsers, not authentication; the
compute service must validate every request itself.
