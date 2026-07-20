import { Chess } from "../vendor/chess/chess.js";
import { sideToMoveScore } from "./engine-score.js";

const VALUE = Object.freeze({ p: 1, n: 3, b: 3, r: 5, q: 9, k: 99 });
const RAY_DIRECTIONS = Object.freeze([
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
]);
const SPECIFIC_PRIORITY = Object.freeze([
  "mate", "smotheredMate", "backRankMate", "underPromotion", "promotion",
  "doubleCheck", "fork", "discoveredAttack", "pin", "skewer", "hangingPiece",
  "attraction", "sacrifice", "advancedPawn", "enPassant", "castling",
  "quietMove", "defensiveMove",
]);
const HIGH_CONFIDENCE_PRIORITY = Object.freeze([
  "mate", "underPromotion", "promotion", "doubleCheck", "fork", "pin",
  "sacrifice", "advancedPawn", "enPassant", "castling",
]);

function moveUci(move) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function findMove(chess, uci) {
  const value = String(uci || "").toLowerCase();
  const legal = chess.moves({ verbose: true });
  const exact = legal.find(move => moveUci(move) === value || moveUci(move).slice(0, 4) === value.slice(0, 4) && !value[4]);
  if (exact) return exact;
  const piece = chess.get(value.slice(0, 2));
  const target = chess.get(value.slice(2, 4));
  if (piece?.type !== "k" || target?.type !== "r" || piece.color !== target.color) return null;
  const kingSide = value.charCodeAt(2) > value.charCodeAt(0);
  return legal.find(move => move.san === (kingSide ? "O-O" : "O-O-O")) || null;
}

function square(file, rank) {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8 ? `${String.fromCharCode(97 + file)}${rank + 1}` : null;
}

function coordinates(name) {
  return [name.charCodeAt(0) - 97, Number(name[1]) - 1];
}

function pieceEntries(chess, color = null) {
  const entries = [];
  const board = chess.board();
  for (let row = 0; row < board.length; row += 1) for (let column = 0; column < board[row].length; column += 1) {
    const piece = board[row][column];
    if (piece && (!color || piece.color === color)) entries.push({ piece, square: `${String.fromCharCode(97 + column)}${8 - row}` });
  }
  return entries;
}

function attacksFrom(chess, from) {
  const piece = chess.get(from);
  if (!piece) return [];
  const [file, rank] = coordinates(from);
  const targets = [];
  const add = (f, r) => {
    const targetSquare = square(f, r);
    if (!targetSquare) return;
    const target = chess.get(targetSquare);
    if (!target || target.color !== piece.color) targets.push({ square: targetSquare, piece: target || null });
  };
  if (piece.type === "n") for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) add(file + df, rank + dr);
  else if (piece.type === "p") for (const df of [-1, 1]) add(file + df, rank + (piece.color === "w" ? 1 : -1));
  else if (piece.type === "k") for (const [df, dr] of RAY_DIRECTIONS) add(file + df, rank + dr);
  else {
    const directions = piece.type === "b" ? RAY_DIRECTIONS.slice(4)
      : piece.type === "r" ? RAY_DIRECTIONS.slice(0, 4)
      : RAY_DIRECTIONS;
    for (const [df, dr] of directions) {
      let f = file + df;
      let r = rank + dr;
      while (square(f, r)) {
        const targetSquare = square(f, r);
        const target = chess.get(targetSquare);
        if (!target) targets.push({ square: targetSquare, piece: null });
        else {
          if (target.color !== piece.color) targets.push({ square: targetSquare, piece: target });
          break;
        }
        f += df;
        r += dr;
      }
    }
  }
  return targets;
}

function material(chess, color) {
  return pieceEntries(chess).reduce((total, { piece }) => total + (piece.color === color ? 1 : -1) * VALUE[piece.type], 0);
}

function opponent(color) {
  return color === "w" ? "b" : "w";
}

function isAdvancedPawn(move) {
  return move.piece === "p" && (move.color === "w" ? Number(move.to[1]) >= 7 : Number(move.to[1]) <= 2);
}

function discoveredRay(before, move, color) {
  for (const { piece, square: sliderSquare } of pieceEntries(before, color)) {
    if (sliderSquare === move.from || !["b", "r", "q"].includes(piece.type)) continue;
    const [file, rank] = coordinates(sliderSquare);
    const directions = piece.type === "b" ? RAY_DIRECTIONS.slice(4)
      : piece.type === "r" ? RAY_DIRECTIONS.slice(0, 4)
      : RAY_DIRECTIONS;
    for (const [df, dr] of directions) {
      let f = file + df;
      let r = rank + dr;
      let first = null;
      while (square(f, r)) {
        const current = square(f, r);
        const target = before.get(current);
        if (target) {
          if (!first) first = { square: current, piece: target };
          else {
            if (first.square === move.from && target.color !== color && (target.type === "k" || VALUE[target.type] >= 3)) return true;
            break;
          }
        }
        f += df;
        r += dr;
      }
    }
  }
  return false;
}

function createdPin(chess, move, color) {
  const enemy = opponent(color);
  const king = pieceEntries(chess, enemy).find(entry => entry.piece.type === "k")?.square;
  if (!king) return false;
  const [file, rank] = coordinates(king);
  for (const [df, dr] of RAY_DIRECTIONS) {
    let f = file + df;
    let r = rank + dr;
    let candidate = null;
    while (square(f, r)) {
      const current = square(f, r);
      const piece = chess.get(current);
      if (piece) {
        if (!candidate) {
          if (piece.color !== enemy || piece.type === "k") break;
          candidate = { piece, square: current };
        } else {
          if (piece.color !== color || current !== move.to) break;
          const diagonal = df !== 0 && dr !== 0;
          const pinner = diagonal ? ["b", "q"].includes(piece.type) : ["r", "q"].includes(piece.type);
          if (pinner && VALUE[candidate.piece.type] > VALUE[piece.type]) return true;
          break;
        }
      }
      f += df;
      r += dr;
    }
  }
  return false;
}

function isFork(chess, move) {
  const moved = chess.get(move.to);
  if (!moved || moved.type === "k") return false;
  const targets = attacksFrom(chess, move.to)
    .filter(target => target.piece && target.piece.color !== move.color && target.piece.type !== "p")
    .filter(target => target.piece.type === "k" || VALUE[target.piece.type] > VALUE[moved.type]);
  if (targets.length < 2) return false;
  const enemyAttackers = chess.attackers(move.to, opponent(move.color))
    .map(attacker => chess.get(attacker)).filter(Boolean);
  const defended = chess.attackers(move.to, move.color).length > 0;
  return defended || !enemyAttackers.some(attacker => VALUE[attacker.type] < VALUE[moved.type]);
}

function isHangingCapture(before, move) {
  const captured = before.get(move.to);
  if (!captured || captured.type === "p") return false;
  return before.attackers(move.to, captured.color).length === 0;
}

function isDoubleCheck(chess, color) {
  if (!chess.isCheck()) return false;
  const king = pieceEntries(chess, opponent(color)).find(entry => entry.piece.type === "k")?.square;
  return king ? chess.attackers(king, color).length >= 2 : false;
}

function backRankMate(chess, color) {
  if (!chess.isCheckmate()) return false;
  const king = pieceEntries(chess, opponent(color)).find(entry => entry.piece.type === "k")?.square;
  if (!king) return false;
  const homeRank = opponent(color) === "w" ? "1" : "8";
  return king[1] === homeRank && chess.attackers(king, color).some(attacker => ["r", "q"].includes(chess.get(attacker)?.type));
}

function smotheredMate(chess, color) {
  if (!chess.isCheckmate()) return false;
  const enemy = opponent(color);
  const king = pieceEntries(chess, enemy).find(entry => entry.piece.type === "k")?.square;
  if (!king || !chess.attackers(king, color).some(attacker => chess.get(attacker)?.type === "n")) return false;
  const [file, rank] = coordinates(king);
  return RAY_DIRECTIONS.every(([df, dr]) => {
    const adjacent = square(file + df, rank + dr);
    if (!adjacent) return true;
    const blocker = chess.get(adjacent);
    return blocker?.color === enemy;
  });
}

function buildFrames(fen, moves) {
  const chess = new Chess(fen);
  const beneficiary = chess.turn();
  const frames = [];
  for (const requested of moves || []) {
    const move = findMove(chess, requested);
    if (!move) break;
    const before = new Chess(chess.fen());
    const materialBefore = material(before, beneficiary);
    chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    frames.push({
      before,
      after: new Chess(chess.fen()),
      move,
      uci: moveUci(move),
      materialBefore,
      materialAfter: material(chess, beneficiary),
      beneficiaryMove: move.color === beneficiary,
    });
  }
  return { beneficiary, frames, final: chess };
}

function isSkewer(frames, index) {
  const first = frames[index];
  const reply = frames[index + 1];
  const finish = frames[index + 2];
  if (!first?.beneficiaryMove || reply?.beneficiaryMove || !finish?.beneficiaryMove) return false;
  if (!["b", "r", "q"].includes(first.move.piece) || finish.move.from !== first.move.to || !finish.move.captured) return false;
  const attacked = attacksFrom(first.after, first.move.to).find(target => target.square === reply.move.from)?.piece;
  return Boolean(attacked && VALUE[attacked.type] > VALUE[finish.move.captured]);
}

function isAttraction(frames, index) {
  const offer = frames[index];
  const capture = frames[index + 1];
  const follow = frames[index + 2];
  if (!offer?.beneficiaryMove || capture?.beneficiaryMove || !follow?.beneficiaryMove) return false;
  if (capture.move.to !== offer.move.to || !capture.move.captured || !["k", "q", "r"].includes(capture.move.piece)) return false;
  return follow.after.isCheck() || follow.move.to === capture.move.to
    || attacksFrom(follow.after, follow.move.to).some(target => target.square === capture.move.to);
}

function isQuiet(frame) {
  if (frame.move.captured || frame.before.isCheck() || frame.after.isCheck() || isAdvancedPawn(frame.move) || frame.move.piece === "k") return false;
  return !attacksFrom(frame.after, frame.move.to).some(target => target.piece && target.piece.color !== frame.move.color);
}

export function classifyTacticalLine({ fen, moves, result = null }) {
  const { beneficiary, frames, final } = buildFrames(fen, moves);
  const themes = new Set();
  const beneficiaryFrames = frames.filter(frame => frame.beneficiaryMove);
  if (!beneficiaryFrames.length) return { primary: "calculation", themes: [], specificThemes: [], plies: 0 };

  const checkmate = final.isCheckmate();
  if (checkmate || Number(result?.mate) > 0) themes.add("mate");
  if (checkmate && backRankMate(final, beneficiary)) themes.add("backRankMate");
  if (checkmate && smotheredMate(final, beneficiary)) themes.add("smotheredMate");
  if (checkmate) themes.add(`mateIn${Math.max(1, Math.ceil(beneficiaryFrames.length))}`);

  const initialMaterial = beneficiaryFrames[0].materialBefore;
  const lastBeneficiaryFrame = beneficiaryFrames[beneficiaryFrames.length - 1];
  let beneficiaryIndex = 0;
  let sacrificed = false;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!frame.beneficiaryMove) continue;
    const firstBeneficiaryMove = beneficiaryIndex === 0;
    const lastBeneficiaryMove = frame === lastBeneficiaryFrame;
    beneficiaryIndex += 1;
    if (frame.move.promotion) {
      themes.add("promotion");
      if (frame.move.promotion !== "q") themes.add("underPromotion");
    }
    if (isAdvancedPawn(frame.move)) themes.add("advancedPawn");
    if (frame.move.flags?.includes("e")) themes.add("enPassant");
    if (frame.move.flags?.includes("k") || frame.move.flags?.includes("q")) themes.add("castling");
    if (isDoubleCheck(frame.after, beneficiary)) themes.add("doubleCheck");
    if (!lastBeneficiaryMove && isFork(frame.after, frame.move)) themes.add("fork");
    if ((!firstBeneficiaryMove || frame.after.isCheck()) && discoveredRay(frame.before, frame.move, beneficiary)) themes.add("discoveredAttack");
    if (createdPin(frame.after, frame.move, beneficiary)) themes.add("pin");
    if (firstBeneficiaryMove && isHangingCapture(frame.before, frame.move)) themes.add("hangingPiece");
    if (isSkewer(frames, index)) themes.add("skewer");
    if (isAttraction(frames, index)) themes.add("attraction");
    if (isQuiet(frame) && index < frames.length - 1) themes.add("quietMove");
    if (index === 0 && frame.before.isCheck() && !frame.move.captured && !frame.after.isCheck()) themes.add("defensiveMove");
    if (frame.materialAfter <= initialMaterial - 2) sacrificed = true;
  }
  const recovered = beneficiaryFrames.some(frame => frame.materialAfter >= initialMaterial);
  if (sacrificed && (recovered || themes.has("mate"))) themes.add("sacrifice");

  if (!themes.has("mate")) {
    const evaluation = sideToMoveScore(result);
    themes.add(evaluation > 600 ? "crushing" : evaluation > 200 ? "advantage" : "equality");
  }
  themes.add(beneficiaryFrames.length === 1 ? "oneMove" : beneficiaryFrames.length === 2 ? "short" : beneficiaryFrames.length >= 4 ? "veryLong" : "long");

  const allThemes = [...themes];
  const candidateThemes = SPECIFIC_PRIORITY.filter(theme => themes.has(theme));
  const specificThemes = HIGH_CONFIDENCE_PRIORITY.filter(theme => themes.has(theme));
  return {
    primary: specificThemes[0] || "calculation",
    themes: allThemes,
    specificThemes,
    candidateThemes,
    plies: frames.length,
  };
}

export const TACTICAL_SPECIFIC_THEMES = HIGH_CONFIDENCE_PRIORITY;
