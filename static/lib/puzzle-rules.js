export const PUZZLE_THRESHOLDS = Object.freeze({
  minimumCentipawnLoss: 300,
  clearlyWinningCentipawns: 300,
});

export function classifyPuzzleEligibility({ bestValue, playedValue, bestMate = null, playedMate = null }) {
  const missedMate = bestMate !== null && bestMate > 0 && !(playedMate !== null && playedMate > 0);
  const loss = Math.max(0, bestValue - playedValue);
  if (missedMate) return { eligible: true, category: "Missed mate", loss };
  if (loss < PUZZLE_THRESHOLDS.minimumCentipawnLoss) return { eligible: false, category: null, loss };
  return {
    eligible: true,
    category: bestValue >= PUZZLE_THRESHOLDS.clearlyWinningCentipawns ? "Missed win" : "Blunder",
    loss,
  };
}
