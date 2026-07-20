import { Chess } from "../vendor/chess/chess.js";

const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
export const BRILLIANCY_THRESHOLDS = Object.freeze({
  maximumLoss: 80,
  minimumEvaluation: -100,
  clearlyWinning: 900,
  onlyMoveBonus: 150,
  endgameBonus: 80,
});

function uciFor(move) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function material(chess, color) {
  return chess.board().flat().filter(Boolean).reduce((total, piece) => total + (piece.color === color ? PIECE_VALUES[piece.type] : -PIECE_VALUES[piece.type]), 0);
}

function countPieces(chess) {
  return chess.board().flat().filter(Boolean).length;
}

export function findSacrificeCandidate(fen, playedUci) {
  const before = new Chess(fen);
  const played = before.moves({ verbose: true }).find(move => uciFor(move) === playedUci || uciFor(move).slice(0, 4) === playedUci.slice(0, 4) && !playedUci[4]);
  if (!played) return null;
  const mover = before.get(played.from);
  const capturedValue = PIECE_VALUES[played.captured] || 0;
  const after = new Chess(fen);
  after.move({ from: played.from, to: played.to, promotion: played.promotion });
  const opponent = mover.color === "w" ? "b" : "w";

  const captures = after.moves({ verbose: true }).map(reply => {
    if (!reply.captured) return null;
    const victim = after.get(reply.to);
    if (!victim || victim.color !== mover.color || PIECE_VALUES[victim.type] < PIECE_VALUES.n) return null;
    const movedPiece = reply.to === played.to;
    const investment = Math.max(0, PIECE_VALUES[victim.type] - capturedValue);
    return {
      reply: uciFor(reply),
      square: reply.to,
      piece: victim.type,
      pieceName: PIECE_NAMES[victim.type],
      investment,
      movedPiece,
      wasAlreadyOffered: !movedPiece && before.isAttacked(reply.to, opponent),
    };
  }).filter(Boolean);

  const offers = [...new Map(captures.map(offer => [offer.square, offer])).values()]
    .filter(offer => offer.investment >= 140)
    .sort((a, b) => b.investment - a.investment);

  const strongest = offers[0];
  if (!strongest) return null;
  return {
    ...strongest,
    offers,
    played,
    playedSan: played.san,
    moverColor: mover.color,
    pieceCount: countPieces(before),
    beforeMaterial: material(before, mover.color),
  };
}

export function analyzeSacrificeLine(fen, pv, color) {
  const chess = new Chess(fen);
  const starting = material(chess, color);
  let investment = 0;
  const san = [];
  for (const uci of pv.slice(0, 10)) {
    const move = chess.moves({ verbose: true }).find(candidate => uciFor(candidate) === uci || uciFor(candidate).slice(0, 4) === uci.slice(0, 4) && !uci[4]);
    if (!move) break;
    san.push(move.san);
    chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    investment = Math.max(investment, starting - material(chess, color));
  }
  return { investment, san: san.join(" ") };
}

export function pvMaterialInvestment(fen, pv, color) {
  return analyzeSacrificeLine(fen, pv, color).investment;
}

export function alternativeMoves(fen, excludedUci) {
  const chess = new Chess(fen);
  return chess.moves({ verbose: true }).map(uciFor).filter(uci => uci !== excludedUci && !(uci.slice(0, 4) === excludedUci.slice(0, 4) && !excludedUci[4]));
}

export function isSoundBrilliancy({ loss, playedValue, alternativeValue, pieceCount, keepsWinningMate = false }) {
  const nearlyBest = keepsWinningMate || loss <= BRILLIANCY_THRESHOLDS.maximumLoss;
  const soundAfter = keepsWinningMate || playedValue >= BRILLIANCY_THRESHOLDS.minimumEvaluation;
  const alternativeGap = playedValue - alternativeValue;
  const notTriviallyWinning = alternativeValue < BRILLIANCY_THRESHOLDS.clearlyWinning || alternativeGap >= BRILLIANCY_THRESHOLDS.onlyMoveBonus;
  const satisfiesEndgameRule = pieceCount > 12 || alternativeGap >= BRILLIANCY_THRESHOLDS.endgameBonus;
  return nearlyBest && soundAfter && notTriviallyWinning && satisfiesEndgameRule;
}

export function explainBrilliancy(candidate, line) {
  const kind = candidate.movedPiece
    ? `offers the ${candidate.pieceName} on ${candidate.square}`
    : candidate.wasAlreadyOffered
      ? `deliberately keeps the ${candidate.pieceName} on ${candidate.square} en prise`
      : `uncovers an attack on the ${candidate.pieceName} on ${candidate.square}`;
  const recovered = line.investment >= candidate.investment
    ? "and the engine's best-defense line accepts it, proving the compensation"
    : "while the engine's best defense has to decline the material";
  return `${candidate.playedSan} ${kind} ${recovered}.`;
}
