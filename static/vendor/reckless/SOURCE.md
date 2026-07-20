# Reckless WebAssembly source

The bundled WebAssembly engine was compiled from:

- Repository: https://github.com/codedeliveryservice/Reckless
- Commit: `a6fa482c7d46fb81831573f10be396f20a5efdb5`
- Upstream version: `0.10.0-dev`
- License: GNU Affero General Public License v3.0

Build target: `wasm32-unknown-unknown`, release profile, Syzygy disabled, SIMD128 enabled, single-threaded browser memory.

ChessReplay modification: the WASM interface and thread pool accept a list of
legal UCI root moves and filter the actual root move list before search. The
complete source patch is distributed beside the engine assets as
`RECKLESS-SEARCHMOVES.patch`. No evaluation or principal-variation emulation is
used.

The generated `.wasm` is stored as four byte-for-byte sequential chunks and reassembled in the Web Worker before instantiation. This keeps each static asset below common hosting limits without changing the engine binary.

Compiled engine SHA-256: `8122080ee45b6ed8b1c876e04c4619449dcebddd1ce3259193de25c77fd4ba65`.
