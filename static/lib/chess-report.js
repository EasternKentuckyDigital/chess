import { Chess } from "../vendor/chess/chess.js";
import { createEngine } from "./engine-providers.js?v=21";
import { DEFAULT_REPORT_GAMES, importGames, getGameDetail, normalizeReportGameLimit } from "./game-import.js?v=21";
import { centipawnLoss, oppositeSideResult } from "./engine-score.js";
import { classifyTacticalLine } from "./tactical-themes.js";

export const MIN_REPORT_LOSS = 80;
// Name a report tactic from the immediate engine refutation only. Later PV moves
// often describe the conversion after the tactic rather than the tactic itself.
const REPORT_TACTICAL_WINDOW_PLIES = 1;

const THEMES = {
  fork: { label: "Missed forks", slug: "fork", advice: "Practice spotting one move that attacks two valuable targets." },
  forkVulnerability: { label: "Getting forked", slug: "fork", advice: "Before committing a move, scan every enemy knight, pawn, and queen fork." },
  discoveredAttack: { label: "Missed discovered attacks", slug: "discoveredAttack", advice: "Scan for line pieces hidden behind a movable blocker." },
  discoveredVulnerability: { label: "Discovered attacks against you", slug: "discoveredAttack", advice: "Notice when one enemy move can uncover a rook, bishop, or queen." },
  mate: { label: "Mating attacks", slug: "mate", advice: "Calculate checks and forced replies until the king is safe." },
  check: { label: "Checks and forcing moves", slug: "mate", advice: "Start each calculation with checks, captures, and threats." },
  hangingPiece: { label: "Loose and hanging pieces", slug: "hangingPiece", advice: "Before moving, count every undefended or newly attacked piece." },
  pin: { label: "Pins", slug: "pin", advice: "Check whether a piece is tied to its king or a more valuable piece." },
  skewer: { label: "Skewers", slug: "skewer", advice: "Look beyond the first attacked piece for the target behind it." },
  promotion: { label: "Promotion tactics", slug: "promotion", advice: "Track advanced pawns and calculate every promotion race." },
  underPromotion: { label: "Underpromotions", slug: "underPromotion", advice: "When promotion is forced, compare checks and stalemate risks for every piece." },
  advancedPawn: { label: "Advanced pawns", slug: "advancedPawn", advice: "Treat pawns on the sixth and seventh ranks as immediate tactical threats." },
  sacrifice: { label: "Sacrificial attacks", slug: "sacrifice", advice: "Calculate the forced return before accepting or rejecting a sacrifice." },
  attraction: { label: "Attraction tactics", slug: "attraction", advice: "Notice when a sacrifice drags a king or major piece onto a vulnerable square." },
  quietMove: { label: "Quiet tactical moves", slug: "quietMove", advice: "After forcing moves, look for a quiet move that leaves no defense." },
  defensiveMove: { label: "Defensive resources", slug: "defensiveMove", advice: "Ask what your opponent threatens before choosing your plan." },
  calculation: { label: "Forcing calculation", slug: "mix", advice: "Calculate the complete forcing line instead of guessing a motif." },
  crushing: { label: "Converting advantages", slug: "crushing", advice: "Simplify only when it preserves the concrete win." },
};

function findMove(chess, uci) {
  return chess.moves({ verbose: true }).find(move => move.from === uci?.slice(0, 2)
    && move.to === uci?.slice(2, 4) && (!uci?.[4] || move.promotion === uci[4]));
}

function sameMove(left, right) {
  if (!left || !right) return false;
  return left === right || left.slice(0, 4) === right.slice(0, 4) && (!left[4] || !right[4]);
}

function bestLine(best) {
  const pv = Array.isArray(best?.pv) ? best.pv.filter(Boolean) : [];
  if (best?.bestmove && !sameMove(pv[0], best.bestmove)) pv.unshift(best.bestmove);
  return pv.slice(0, REPORT_TACTICAL_WINDOW_PLIES);
}

function punishmentLine(fen, playedUci, playedResult) {
  const chess = new Chess(fen);
  const playedMove = findMove(chess, playedUci);
  if (!playedMove) return null;
  chess.move({ from: playedMove.from, to: playedMove.to, promotion: playedMove.promotion });
  const pv = Array.isArray(playedResult?.pv) ? playedResult.pv.filter(Boolean) : [];
  if (sameMove(pv[0], playedUci)) pv.shift();
  if (!pv.length) return null;
  return { fen: chess.fen(), moves: pv.slice(0, REPORT_TACTICAL_WINDOW_PLIES), result: oppositeSideResult(playedResult) };
}

function reportPrimary(rawPrimary, punishment) {
  if (punishment && rawPrimary === "fork") return "forkVulnerability";
  if (punishment && rawPrimary === "discoveredAttack") return "discoveredVulnerability";
  if (rawPrimary === "smotheredMate" || rawPrimary === "backRankMate") return "mate";
  return THEMES[rawPrimary] ? rawPrimary : "calculation";
}

export function classifyReportThemes({ fen, best, playedUci = null, played = null }) {
  const punishment = playedUci && played ? punishmentLine(fen, playedUci, played) : null;
  const line = punishment || { fen, moves: bestLine(best), result: best };
  const raw = classifyTacticalLine(line);
  return {
    ...raw,
    rawPrimary: raw.primary,
    primary: reportPrimary(raw.primary, Boolean(punishment)),
    lineSource: punishment ? "punishment" : "missedBestMove",
  };
}

export function classifyReportMotif(input) {
  return classifyReportThemes(input).primary;
}

export function classifySolutionThemes({ fen, moves, result }) {
  return classifyTacticalLine({ fen, moves, result });
}

export function classifySolutionMotif({ fen, bestmove, result, moves = null }) {
  return classifySolutionThemes({ fen, moves: moves || [bestmove], result }).primary;
}

export function accuracyFromLoss(loss) {
  if (!Number.isFinite(loss) || loss >= 5000) return 0;
  return Math.max(0, Math.min(100, 100 * Math.exp(-Math.max(0, loss) / 400)));
}

function abortError() {
  const error = new Error("Report analysis was stopped.");
  error.name = "AbortError";
  error.code = "ABORTED";
  return error;
}

export async function buildChessReport({
  username,
  source,
  importedGames = null,
  onProgress,
  analysisLevel = "superquick",
  gameLimit = DEFAULT_REPORT_GAMES,
  reportMode = "combined",
  signal = null,
  engineFactory = createEngine,
  gameDetail = getGameDetail,
  gameImporter = importGames,
}) {
  const normalizedGameLimit = normalizeReportGameLimit(gameLimit);
  const mode = ["wrapped", "tactics"].includes(reportMode) ? reportMode : "combined";
  const imported = importedGames || await gameImporter({ username, source, scope: mode === "wrapped" ? "wrapped" : "report", gameLimit: normalizedGameLimit });
  if (!imported.games.length) throw new Error("No standard chess games were available for this report.");
  const includeWrapped = mode !== "tactics";
  const includeTactics = mode !== "wrapped";
  const analysisGames = imported.games.slice(0, normalizedGameLimit);
  const wrappedGameRecords = includeWrapped ? analysisGames : [];
  const engine = engineFactory("stockfish-browser", { level: analysisLevel });
  const stopEngine = () => engine.close();
  if (signal?.aborted) {
    engine.close();
    throw abortError();
  }
  signal?.addEventListener("abort", stopEngine, { once: true });
  const counts = Object.fromEntries(Object.keys(THEMES).map(key => [key, 0]));
  const examples = [];
  let positions = 0;
  let mistakes = 0;
  const wrappedGames = new Set(wrappedGameRecords.map(game => game.id));
  const wrappedAccuracy = [];
  const wrappedByGame = [];
  try {
    await engine.init();
    for (let gameIndex = 0; gameIndex < analysisGames.length; gameIndex += 1) {
      if (signal?.aborted) throw abortError();
      const game = analysisGames[gameIndex];
      const detail = gameDetail(game.id);
      const parity = game.playerColor === "white" ? 1 : 0;
      const moves = detail.moves.filter(move => move.ply % 2 === parity);
      const gameAccuracies = [];
      for (let index = 0; index < moves.length; index += 1) {
        if (signal?.aborted) throw abortError();
        const move = moves[index];
        const fen = detail.frames[move.ply - 1].fen;
        positions += 1;
        const best = await engine.evaluate(fen);
        const matches = sameMove(move.uci, best.bestmove);
        if (matches && wrappedGames.has(game.id)) gameAccuracies.push(100);
        if (!matches && best.bestmove && best.bestmove !== "(none)") {
          const played = await engine.evaluate(fen, move.uci);
          const loss = centipawnLoss(best, played);
          if (wrappedGames.has(game.id)) gameAccuracies.push(accuracyFromLoss(loss));
          if (includeTactics && loss >= MIN_REPORT_LOSS) {
            mistakes += 1;
            const classification = classifyReportThemes({ fen, best, playedUci: move.uci, played });
            const motif = classification.primary;
            counts[motif] += 1;
            if (examples.length < 24) examples.push({
              id: `${game.id}:${move.ply}`,
              motif,
              label: THEMES[motif].label,
              themes: classification.themes,
              confidence: motif === "calculation" ? "general" : "specific",
              fen,
              bestMove: best.bestmove,
              playedMove: move.uci,
              loss,
              consequence: played.mate !== null && played.mate < 0
                ? `allowed mate in ${Math.abs(played.mate)}`
                : best.mate !== null && best.mate > 0
                  ? `missed mate in ${best.mate}`
                  : `lost ${(loss / 100).toFixed(1)} pawns`,
              opponent: game.opponent,
              date: game.date,
            });
          }
        }
        onProgress?.({ game: gameIndex + 1, games: analysisGames.length, move: index + 1, moves: moves.length });
      }
      if (wrappedGames.has(game.id) && gameAccuracies.length) {
        wrappedAccuracy.push(...gameAccuracies);
        wrappedByGame.push({ id: game.id, accuracy: gameAccuracies.reduce((sum, value) => sum + value, 0) / gameAccuracies.length });
      }
    }
  } finally {
    signal?.removeEventListener("abort", stopEngine);
    engine.close();
  }
  const recommendations = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, count, ...THEMES[id], url: `https://lichess.org/training/${THEMES[id].slug}` }));
  return {
    username,
    source,
    mode,
    gameLimit: normalizedGameLimit,
    generatedAt: Date.now(),
    games: analysisGames.length,
    positions,
    mistakes,
    counts,
    recommendations,
    examples,
    wrapped: includeWrapped ? {
      games: wrappedByGame.length,
      moves: wrappedAccuracy.length,
      averageAccuracy: wrappedAccuracy.length ? Number((wrappedAccuracy.reduce((sum, value) => sum + value, 0) / wrappedAccuracy.length).toFixed(1)) : null,
      wins: wrappedGameRecords.filter(game => game.result === "Win").length,
      draws: wrappedGameRecords.filter(game => game.result === "Draw").length,
      losses: wrappedGameRecords.filter(game => game.result === "Loss").length,
    } : null,
  };
}
