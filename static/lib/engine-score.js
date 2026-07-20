const MATE_SCORE = 100_000;
const MATE_PLY_PENALTY = 100;

/**
 * Convert a UCI engine result to a sortable score for the side whose turn it is.
 * Higher is always better for the side to move, including when Black is moving.
 */
export function sideToMoveScore(result) {
  if (result?.mate !== null && result?.mate !== undefined) {
    const mate = Number(result.mate);
    if (!Number.isFinite(mate) || mate === 0) return 0;
    const distancePenalty = Math.abs(mate) * MATE_PLY_PENALTY;
    return mate > 0 ? MATE_SCORE - distancePenalty : -MATE_SCORE + distancePenalty;
  }
  const cp = Number(result?.cp);
  return Number.isFinite(cp) ? cp : 0;
}

export function sideToMoveFactor(fen) {
  const activeColor = String(fen || "").trim().split(/\s+/)[1];
  if (activeColor === "w") return 1;
  if (activeColor === "b") return -1;
  throw new Error("FEN must identify White or Black as the side to move.");
}

/** Convert the app's side-to-move engine score to the White point of view. */
export function whitePerspectiveScore(result, fen) {
  return sideToMoveScore(result) * sideToMoveFactor(fen);
}

/** Convert a Lichess White-perspective centipawn value to UCI side-to-move form. */
export function lichessCentipawnsToSideToMove(cp, fen) {
  const value = Number(cp);
  return (Number.isFinite(value) ? value : 0) * sideToMoveFactor(fen);
}

/**
 * Re-express a result after advancing exactly one ply. This is needed when a
 * constrained-search PV is inspected from the opponent's resulting position.
 */
export function oppositeSideResult(result) {
  return {
    ...result,
    cp: result?.cp === null || result?.cp === undefined ? result?.cp ?? null : -Number(result.cp),
    mate: result?.mate === null || result?.mate === undefined ? result?.mate ?? null : -Number(result.mate),
  };
}

/**
 * Both searches begin from the same FEN, so their UCI scores share the same
 * side-to-move perspective. No White/Black sign flip belongs in this subtraction.
 */
export function centipawnLoss(best, played) {
  return Math.max(0, sideToMoveScore(best) - sideToMoveScore(played));
}
