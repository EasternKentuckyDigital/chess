/*
 * TypeScript port and browser adaptation of aslyamov/chess_detect.
 * Original project: https://github.com/aslyamov/chess_detect
 * Original commit: 662ad8d64f59a4bbc83cc003585f9bf10f4b7a70
 * Copyright (c) 2025 aslyamov. MIT licensed; see THIRD_PARTY_LICENSES.md.
 *
 * The port keeps chess_detect's material-aware fork, pin, skewer,
 * discovered-check, trapped-piece, hanging-capture, defender-removal, and
 * pin-exploitation rules. It uses the site's existing chess.js board model
 * and returns structured themes instead of annotated PGN comments.
 */

// The source is emitted into static/lib, where this relative import resolves.
// @ts-ignore -- the vendored ESM module intentionally has no declaration file.
import { Chess } from "../vendor/chess/chess.js";

export const CHESS_DETECT_COMMIT = "662ad8d64f59a4bbc83cc003585f9bf10f4b7a70";

type Color = "w" | "b";
type PieceType = "p" | "n" | "b" | "r" | "q" | "k";
type Square = string;

interface Piece {
  color: Color;
  type: PieceType;
}

interface VerboseMove {
  color: Color;
  from: Square;
  to: Square;
  piece: PieceType;
  captured?: PieceType;
  promotion?: PieceType;
  flags: string;
  san: string;
}

interface Board {
  fen(): string;
  turn(): Color;
  get(square: Square): Piece | undefined;
  attackers(square: Square, attackedBy?: Color): Square[];
  isAttacked(square: Square, attackedBy: Color): boolean;
  isCheck(): boolean;
  isCheckmate(): boolean;
  moves(options?: { verbose?: boolean; square?: Square }): VerboseMove[];
  move(move: { from: Square; to: Square; promotion?: PieceType }): VerboseMove;
  undo(): VerboseMove | null;
}

export interface PreviousMoveContext {
  from: Square;
  to: Square;
  wasCapture: boolean;
}

export interface TacticTheme {
  id: string;
  label: string;
  phrase: string;
  priority: number;
  targets: Square[];
}

export interface TacticClassification {
  san: string;
  fenAfter: string;
  themes: TacticTheme[];
  themeIds: string[];
  /** Stable storage alias retained for existing saved puzzle records. */
  motifIds: string[];
  tagline: string;
  recommendations: LichessRecommendation[];
  analyzer: "chess_detect-ts";
  analyzerCommit: string;
}

export interface LichessRecommendation {
  id: string;
  label: string;
  advice: string;
  sourceTheme: string;
  url: string;
}

const PIECE_VALUES: Readonly<Record<PieceType, number>> = Object.freeze({ p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 });
const PIECE_NAMES: Readonly<Record<PieceType, string>> = Object.freeze({ p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" });
const FILES = "abcdefgh";
const SQUARES: readonly Square[] = Object.freeze(Array.from({ length: 64 }, (_, index) => `${FILES[index % 8]}${Math.floor(index / 8) + 1}`));
const BISHOP_DIRECTIONS = Object.freeze([[-1, -1], [-1, 1], [1, -1], [1, 1]] as const);
const ROOK_DIRECTIONS = Object.freeze([[-1, 0], [1, 0], [0, -1], [0, 1]] as const);
const QUEEN_DIRECTIONS = Object.freeze([...BISHOP_DIRECTIONS, ...ROOK_DIRECTIONS] as const);
const KNIGHT_DELTAS = Object.freeze([[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]] as const);
const KING_DELTAS = QUEEN_DIRECTIONS;

const LICHESS_THEMES: Readonly<Record<string, Omit<LichessRecommendation, "sourceTheme" | "url">>> = Object.freeze({
  double_check: { id: "doubleCheck", label: "Double checks", advice: "Practice positions where moving one piece reveals a second check." },
  fork: { id: "fork", label: "Forks", advice: "Practice moves that attack two valuable targets at once." },
  discovered_check: { id: "discoveredCheck", label: "Discovered checks", advice: "Look for a useful move that uncovers a line-piece check." },
  pin: { id: "pin", label: "Pins", advice: "Look for pieces tied to a king or a more valuable piece." },
  skewer: { id: "skewer", label: "Skewers", advice: "Look through the first target to the piece behind it." },
  trapped_piece: { id: "trappedPiece", label: "Trapped pieces", advice: "Count every safe square before closing the net." },
  hanging_capture: { id: "hangingPiece", label: "Hanging pieces", advice: "Check every loose or insufficiently defended piece." },
  removing_defender_material: { id: "capturingDefender", label: "Capture the defender", advice: "Identify the defender holding a tactical position together." },
  removing_defender_mate: { id: "capturingDefender", label: "Capture the defender", advice: "Remove defenders of critical mating squares." },
  exploiting_pin: { id: "pin", label: "Exploit pins", advice: "Attack a pinned piece or use the fact that a pinned defender cannot recapture." },
});

function opposite(color: Color): Color { return color === "w" ? "b" : "w"; }
function pieceValue(piece: Piece | PieceType | undefined): number { return piece ? PIECE_VALUES[typeof piece === "string" ? piece : piece.type] : 0; }
function boardFromFen(fen: string): Board { return new Chess(fen) as unknown as Board; }
function coords(square: Square): [number, number] { return [Number(square[1]) - 1, FILES.indexOf(square[0])]; }
function squareAt(rank: number, file: number): Square | null { return rank >= 0 && rank < 8 && file >= 0 && file < 8 ? `${FILES[file]}${rank + 1}` : null; }
function sameDirection(left: readonly [number, number], right: readonly [number, number]): boolean { return left[0] === right[0] && left[1] === right[1]; }
function directionsFor(type: PieceType): readonly (readonly [number, number])[] {
  return type === "b" ? BISHOP_DIRECTIONS : type === "r" ? ROOK_DIRECTIONS : type === "q" ? QUEEN_DIRECTIONS : [];
}

function castRay(board: Board, start: Square, direction: readonly [number, number], limit = 0): Array<[Square, Piece]> {
  const found: Array<[Square, Piece]> = [];
  let [rank, file] = coords(start);
  rank += direction[0];
  file += direction[1];
  while (true) {
    const square = squareAt(rank, file);
    if (!square) break;
    const piece = board.get(square);
    if (piece) {
      found.push([square, piece]);
      if (limit && found.length >= limit) break;
    }
    rank += direction[0];
    file += direction[1];
  }
  return found;
}

function attackedSquaresFrom(board: Board, square: Square): Square[] {
  const piece = board.get(square);
  if (!piece) return [];
  const [rank, file] = coords(square);
  const result: Square[] = [];
  if (piece.type === "p") {
    const step = piece.color === "w" ? 1 : -1;
    for (const df of [-1, 1]) {
      const target = squareAt(rank + step, file + df);
      if (target) result.push(target);
    }
    return result;
  }
  if (piece.type === "n" || piece.type === "k") {
    for (const [dr, df] of piece.type === "n" ? KNIGHT_DELTAS : KING_DELTAS) {
      const target = squareAt(rank + dr, file + df);
      if (target) result.push(target);
    }
    return result;
  }
  for (const direction of directionsFor(piece.type)) {
    let r = rank + direction[0];
    let f = file + direction[1];
    while (true) {
      const target = squareAt(r, f);
      if (!target) break;
      result.push(target);
      if (board.get(target)) break;
      r += direction[0];
      f += direction[1];
    }
  }
  return result;
}

function kingSquare(board: Board, color: Color): Square | null {
  return SQUARES.find(square => board.get(square)?.color === color && board.get(square)?.type === "k") || null;
}

function isPieceVulnerable(board: Board, square: Square): boolean {
  const piece = board.get(square);
  if (!piece) return false;
  const attackers = board.attackers(square, opposite(piece.color));
  if (!attackers.length) return false;
  const defenders = board.attackers(square, piece.color);
  if (!defenders.length) return true;
  const value = pieceValue(piece);
  return attackers.some(attackerSquare => {
    const attacker = board.get(attackerSquare);
    return attacker?.type !== "k" && pieceValue(attacker) < value;
  });
}

function isAbsolutelyPinned(board: Board, color: Color, targetSquare: Square): boolean {
  const target = board.get(targetSquare);
  const king = kingSquare(board, color);
  if (!target || target.color !== color || !king || targetSquare === king) return false;
  const [kingRank, kingFile] = coords(king);
  const [targetRank, targetFile] = coords(targetSquare);
  const dr = Math.sign(targetRank - kingRank);
  const df = Math.sign(targetFile - kingFile);
  if (!dr && !df) return false;
  if (dr !== 0 && df !== 0 && Math.abs(targetRank - kingRank) !== Math.abs(targetFile - kingFile)) return false;
  if (dr === 0 && targetRank !== kingRank || df === 0 && targetFile !== kingFile) return false;
  let r = kingRank + dr;
  let f = kingFile + df;
  while (true) {
    const square = squareAt(r, f);
    if (!square) return false;
    if (square === targetSquare) break;
    if (board.get(square)) return false;
    r += dr;
    f += df;
  }
  r += dr;
  f += df;
  while (true) {
    const square = squareAt(r, f);
    if (!square) return false;
    const piece = board.get(square);
    if (piece) {
      if (piece.color === color) return false;
      const diagonal = dr !== 0 && df !== 0;
      return piece.type === "q" || diagonal && piece.type === "b" || !diagonal && piece.type === "r";
    }
    r += dr;
    f += df;
  }
}

function findRelativePin(board: Board, targetSquare: Square, pinnerSide: Color, excludeSquare?: Square): [Square, Square, Piece] | null {
  const target = board.get(targetSquare);
  if (!target) return null;
  for (const direction of QUEEN_DIRECTIONS) {
    const backward = [-direction[0], -direction[1]] as const;
    const pinnerHit = castRay(board, targetSquare, backward, 1)[0];
    if (!pinnerHit) continue;
    const [pinnerSquare, pinner] = pinnerHit;
    if (pinnerSquare === excludeSquare || pinner.color !== pinnerSide || !["b", "r", "q"].includes(pinner.type)) continue;
    if (pinner.type === "b" && !BISHOP_DIRECTIONS.some(item => sameDirection(item, direction))) continue;
    if (pinner.type === "r" && !ROOK_DIRECTIONS.some(item => sameDirection(item, direction))) continue;
    const behindHit = castRay(board, targetSquare, direction, 1)[0];
    if (!behindHit) continue;
    const [behindSquare, behind] = behindHit;
    if (behind.color === target.color && pieceValue(behind) > pieceValue(target)) return [pinnerSquare, behindSquare, behind];
  }
  return null;
}

function legalMovesFrom(board: Board, square: Square): VerboseMove[] { return board.moves({ square, verbose: true }); }
function legalMoves(board: Board): VerboseMove[] { return board.moves({ verbose: true }); }
function play(board: Board, move: VerboseMove): void { board.move({ from: move.from, to: move.to, promotion: move.promotion }); }
function canLegallyCapture(board: Board, from: Square, to: Square): boolean { return legalMovesFrom(board, from).some(move => move.to === to && Boolean(move.captured)); }
function pieceDescription(board: Board, square: Square): string {
  const piece = board.get(square);
  return piece ? `${PIECE_NAMES[piece.type]} on ${square}` : square;
}

class MoveContext {
  readonly before: Board;
  readonly after: Board;
  readonly move: VerboseMove;
  readonly movingSide: Color;
  readonly opponentSide: Color;
  readonly movedPiece: Piece | undefined;
  readonly capturedPiece: Piece | undefined;
  readonly pieceAttacks: Square[];
  readonly kingSquare: Square | null;
  readonly attackersOnKing: Square[];
  readonly isCheck: boolean;
  readonly isCapture: boolean;
  readonly movedPieceIsAttacked: boolean;
  readonly movedPieceIsDefended: boolean;
  readonly movedPieceIsHanging: boolean;

  constructor(fen: string, uci: string) {
    this.before = boardFromFen(fen);
    this.movingSide = this.before.turn();
    this.opponentSide = opposite(this.movingSide);
    const move = this.before.moves({ verbose: true }).find(candidate => `${candidate.from}${candidate.to}${candidate.promotion || ""}` === uci);
    if (!move) throw new Error(`Illegal classifier move ${uci} for ${fen}`);
    this.move = move;
    this.capturedPiece = move.captured ? { type: move.captured, color: this.opponentSide } : undefined;
    this.after = boardFromFen(fen);
    this.after.move({ from: move.from, to: move.to, promotion: move.promotion });
    this.movedPiece = this.after.get(move.to);
    this.pieceAttacks = attackedSquaresFrom(this.after, move.to);
    this.kingSquare = kingSquare(this.after, this.opponentSide);
    this.attackersOnKing = this.kingSquare ? this.after.attackers(this.kingSquare, this.movingSide) : [];
    this.isCheck = this.after.isCheck();
    this.isCapture = Boolean(move.captured);
    this.movedPieceIsAttacked = this.after.isAttacked(move.to, this.opponentSide);
    this.movedPieceIsDefended = this.after.isAttacked(move.to, this.movingSide);
    this.movedPieceIsHanging = this.movedPieceIsAttacked && !this.movedPieceIsDefended;
  }

  targetValue(square: Square): number { return pieceValue(this.after.get(square)); }
  isTargetDefended(square: Square): boolean { return this.after.isAttacked(square, this.opponentSide); }
}

function theme(id: string, label: string, phrase: string, priority: number, targets: Square[] = []): TacticTheme {
  return { id, label, phrase, priority, targets };
}

function detectDoubleCheck(ctx: MoveContext): TacticTheme | null {
  return ctx.isCheck && ctx.attackersOnKing.length >= 2
    ? theme("double_check", "Double check", `Double check from ${ctx.attackersOnKing.map(square => pieceDescription(ctx.after, square)).join(" and ")}`, 1, ctx.attackersOnKing)
    : null;
}

function detectFork(ctx: MoveContext): TacticTheme | null {
  if (!ctx.movedPiece) return null;
  const attackerValue = pieceValue(ctx.movedPiece);
  const targets: Square[] = [];
  let attacksKing = false;
  for (const square of ctx.pieceAttacks) {
    const target = ctx.after.get(square);
    if (!target || target.color === ctx.movingSide) continue;
    const value = pieceValue(target);
    if (target.type === "k") { targets.push(square); attacksKing = true; }
    else if (target.type !== "p" && value > attackerValue) targets.push(square);
    else if (target.type !== "p" && value === attackerValue && !ctx.isTargetDefended(square)) targets.push(square);
    else if (!ctx.isTargetDefended(square)) targets.push(square);
  }
  if (targets.length < 2 || !attacksKing && ctx.movedPieceIsHanging) return null;
  for (const attackerSquare of ctx.after.attackers(ctx.move.to, ctx.opponentSide)) {
    const attacker = ctx.after.get(attackerSquare);
    if (!attacker || attacker.type === "k" || !canLegallyCapture(ctx.after, attackerSquare, ctx.move.to)) continue;
    if (!ctx.movedPieceIsDefended || pieceValue(attacker) <= attackerValue) return null;
  }
  if (!attacksKing) {
    const cheapest = [...targets].sort((left, right) => ctx.targetValue(left) - ctx.targetValue(right))[0];
    if (ctx.targetValue(cheapest) <= attackerValue) {
      for (const escape of targets.filter(square => square !== cheapest)) {
        for (const move of legalMovesFrom(ctx.after, escape)) {
          play(ctx.after, move);
          const defended = ctx.after.isAttacked(cheapest, ctx.opponentSide);
          ctx.after.undo();
          if (defended) return null;
        }
      }
    }
  }
  return theme("fork", "Fork", `Forks ${targets.map(square => pieceDescription(ctx.after, square)).join(" and ")}`, 2, targets);
}

function detectDiscoveredCheck(ctx: MoveContext): TacticTheme | null {
  if (!ctx.isCheck || !ctx.movedPiece) return null;
  const checker = ctx.attackersOnKing.find(square => square !== ctx.move.to);
  if (!checker) return null;
  const movedValue = pieceValue(ctx.movedPiece);
  let usefulTarget: Square | null = null;
  for (const square of ctx.pieceAttacks) {
    const target = ctx.after.get(square);
    if (!target || target.color === ctx.movingSide || target.type === "k") continue;
    if (pieceValue(target) > movedValue) { usefulTarget = square; break; }
    if (!ctx.after.isAttacked(square, ctx.opponentSide) && !usefulTarget) usefulTarget = square;
  }
  if (!usefulTarget && ctx.isCapture) usefulTarget = ctx.move.to;
  if (!usefulTarget) return null;
  return theme("discovered_check", "Discovered check", `Uncovers check from ${pieceDescription(ctx.after, checker)}`, 3, [checker, usefulTarget]);
}

function detectPin(ctx: MoveContext): TacticTheme | null {
  const pinner = ctx.movedPiece;
  if (!pinner || !["b", "r", "q"].includes(pinner.type)) return null;
  for (const direction of directionsFor(pinner.type)) {
    const ray = castRay(ctx.after, ctx.move.to, direction, 2);
    if (ray.length < 2) continue;
    const [frontSquare, front] = ray[0];
    const [behindSquare, behind] = ray[1];
    if (front.color !== ctx.opponentSide || behind.color !== ctx.opponentSide) continue;
    const frontValue = pieceValue(front);
    const behindValue = pieceValue(behind);
    const canTakePinner = attackedSquaresFrom(ctx.after, frontSquare).includes(ctx.move.to);
    const pinnerDefended = ctx.after.isAttacked(ctx.move.to, ctx.movingSide);
    if (canTakePinner && (!pinnerDefended || frontValue <= pieceValue(pinner))) continue;
    if (behind.type === "k") return theme("pin", "Pin", `Pins ${pieceDescription(ctx.after, frontSquare)} to the king`, 4, [frontSquare, behindSquare]);
    if (behindValue > frontValue) {
      if (ctx.movedPieceIsHanging) continue;
      if (ctx.after.isAttacked(behindSquare, ctx.opponentSide) && pieceValue(pinner) >= behindValue) continue;
      return theme("pin", "Pin", `Pins ${pieceDescription(ctx.after, frontSquare)} to ${pieceDescription(ctx.after, behindSquare)}`, 4, [frontSquare, behindSquare]);
    }
    if (behindValue === frontValue && frontValue > 1) {
      if (ctx.movedPieceIsHanging) continue;
      const otherAttackers = ctx.after.attackers(frontSquare, ctx.movingSide).filter(square => square !== ctx.move.to);
      if (!otherAttackers.length || findRelativePin(ctx.after, frontSquare, ctx.movingSide, ctx.move.to)) continue;
      return theme("pin", "Pin", `Pins ${pieceDescription(ctx.after, frontSquare)} against ${pieceDescription(ctx.after, behindSquare)}`, 4, [frontSquare, behindSquare]);
    }
  }
  return null;
}

function betweenSquares(start: Square, end: Square, direction: readonly [number, number]): Square[] {
  const result: Square[] = [];
  let [rank, file] = coords(start);
  rank += direction[0];
  file += direction[1];
  while (true) {
    const square = squareAt(rank, file);
    if (!square || square === end) break;
    result.push(square);
    rank += direction[0];
    file += direction[1];
  }
  return result;
}

function detectSkewer(ctx: MoveContext): TacticTheme | null {
  const attacker = ctx.movedPiece;
  if (!attacker || !["b", "r", "q"].includes(attacker.type)) return null;
  for (const direction of directionsFor(attacker.type)) {
    const ray = castRay(ctx.after, ctx.move.to, direction, 2);
    if (ray.length < 2) continue;
    const [frontSquare, front] = ray[0];
    const [backSquare, back] = ray[1];
    if (front.color !== ctx.opponentSide || back.color !== ctx.opponentSide) continue;
    if (front.type === "k") {
      if (isPieceVulnerable(ctx.after, ctx.move.to)) continue;
      if (pieceValue(attacker) >= pieceValue(back) && ctx.after.attackers(backSquare, ctx.opponentSide).length) continue;
      return theme("skewer", "Skewer", `Skewers the king to ${pieceDescription(ctx.after, backSquare)}`, 5, [frontSquare, backSquare]);
    }
    const frontVulnerable = pieceValue(front) === pieceValue(back) && isPieceVulnerable(ctx.after, frontSquare);
    if (pieceValue(front) <= pieceValue(back) && !frontVulnerable || ctx.movedPieceIsHanging) continue;
    if (pieceValue(attacker) >= pieceValue(back) && ctx.after.attackers(backSquare, ctx.opponentSide).length) continue;
    const between = new Set(betweenSquares(ctx.move.to, frontSquare, direction));
    if (between.size && legalMoves(ctx.after).some(move => move.from !== frontSquare && between.has(move.to))) continue;
    return theme("skewer", "Skewer", `Skewers ${pieceDescription(ctx.after, frontSquare)} to ${pieceDescription(ctx.after, backSquare)}`, 5, [frontSquare, backSquare]);
  }
  return null;
}

function canPieceEscape(board: Board, square: Square, piece: Piece): boolean {
  const value = pieceValue(piece);
  for (const move of legalMovesFrom(board, square)) {
    const target = board.get(move.to);
    if (target && pieceValue(target) >= value) return true;
    play(board, move);
    const escaped = !isPieceVulnerable(board, move.to);
    board.undo();
    if (escaped) return true;
  }
  return false;
}

function canBeRescued(board: Board, square: Square): boolean {
  for (const move of legalMoves(board)) {
    if (move.from === square) continue;
    play(board, move);
    const safe = Boolean(board.get(square)) && !isPieceVulnerable(board, square);
    board.undo();
    if (safe) return true;
  }
  return false;
}

function detectTrappedPiece(ctx: MoveContext): TacticTheme | null {
  if (ctx.isCheck) return null;
  for (const square of SQUARES) {
    const piece = ctx.after.get(square);
    if (!piece || piece.color !== ctx.opponentSide || piece.type === "p" || piece.type === "k") continue;
    if (!isPieceVulnerable(ctx.after, square) || canPieceEscape(ctx.after, square, piece) || canBeRescued(ctx.after, square)) continue;
    return theme("trapped_piece", "Trapped piece", `Traps ${pieceDescription(ctx.after, square)}`, 6, [square]);
  }
  return null;
}

function detectHangingCapture(ctx: MoveContext, previousMove?: PreviousMoveContext): TacticTheme | null {
  const captured = ctx.capturedPiece;
  if (!captured || captured.type === "p" || captured.type === "k") return null;
  if (previousMove?.wasCapture && previousMove.to === ctx.move.to) return null;
  if (!isPieceVulnerable(ctx.before, ctx.move.to)) return null;
  return theme("hanging_capture", "Hanging capture", `Wins the loose ${PIECE_NAMES[captured.type]} on ${ctx.move.to}`, 7, [ctx.move.to]);
}

function detectRemovingDefenderMaterial(ctx: MoveContext): TacticTheme | null {
  if (!ctx.capturedPiece) return null;
  for (const targetSquare of attackedSquaresFrom(ctx.before, ctx.move.to)) {
    const target = ctx.after.get(targetSquare);
    if (!target || target.color !== ctx.opponentSide || target.type === "p" || target.type === "k") continue;
    let ourAttackers = ctx.after.attackers(targetSquare, ctx.movingSide);
    if (ctx.movedPieceIsAttacked) ourAttackers = ourAttackers.filter(square => square !== ctx.move.to);
    if (!ourAttackers.length) continue;
    const defenders = ctx.after.attackers(targetSquare, ctx.opponentSide);
    const cheapestAttacker = Math.min(...ourAttackers.map(square => pieceValue(ctx.after.get(square))).filter(value => value < 100));
    if (!defenders.length || cheapestAttacker < pieceValue(target)) {
      return theme("removing_defender_material", "Capture the defender", `Removes the defender of ${pieceDescription(ctx.after, targetSquare)}`, 8, [ctx.move.to, targetSquare]);
    }
  }
  return null;
}

function boardWithTurn(board: Board, turn: Color): Board {
  const fields = board.fen().split(" ");
  fields[1] = turn;
  return boardFromFen(fields.join(" "));
}

function mateInOne(board: Board, side: Color): VerboseMove | null {
  const candidateBoard = board.turn() === side ? board : boardWithTurn(board, side);
  for (const move of legalMoves(candidateBoard)) {
    play(candidateBoard, move);
    const mate = candidateBoard.isCheckmate();
    candidateBoard.undo();
    if (mate) return move;
  }
  return null;
}

function detectRemovingDefenderMate(ctx: MoveContext): TacticTheme | null {
  if (!ctx.capturedPiece || ctx.after.isCheckmate()) return null;
  if (!ctx.isCheck) {
    const mate = mateInOne(ctx.after, ctx.movingSide);
    return mate ? theme("removing_defender_mate", "Capture the defender", `Removes a defender and threatens ${mate.san || `${mate.from}${mate.to}`} mate`, 9, [ctx.move.to, mate.to]) : null;
  }
  let firstMate: VerboseMove | null = null;
  for (const response of legalMoves(ctx.after)) {
    play(ctx.after, response);
    const mate = mateInOne(ctx.after, ctx.movingSide);
    ctx.after.undo();
    if (!mate) return null;
    firstMate ||= mate;
  }
  return firstMate ? theme("removing_defender_mate", "Capture the defender", "Removes a defender while preserving a forced mate threat", 9, [ctx.move.to, firstMate.to]) : null;
}

function pinnedBefore(ctx: MoveContext, square: Square): boolean { return isAbsolutelyPinned(ctx.before, ctx.opponentSide, square); }

function detectExploitingPin(ctx: MoveContext): TacticTheme | null {
  if (!ctx.movedPiece) return null;
  if (ctx.capturedPiece && ctx.capturedPiece.type !== "p" && ctx.capturedPiece.type !== "k") {
    const defenders = ctx.after.attackers(ctx.move.to, ctx.opponentSide);
    if (defenders.length && defenders.every(square => isAbsolutelyPinned(ctx.after, ctx.opponentSide, square) && pinnedBefore(ctx, square))) {
      return theme("exploiting_pin", "Exploit a pin", `Captures on ${ctx.move.to}; every defender is pinned`, 10, [ctx.move.to, ...defenders]);
    }
  }
  const attackerValue = pieceValue(ctx.movedPiece);
  for (const targetSquare of ctx.pieceAttacks) {
    const target = ctx.after.get(targetSquare);
    if (!target || target.color !== ctx.opponentSide || target.type === "p" || target.type === "k") continue;
    if (isAbsolutelyPinned(ctx.after, ctx.opponentSide, targetSquare) && pinnedBefore(ctx, targetSquare) && attackerValue < pieceValue(target)) {
      const safeMove = legalMovesFrom(ctx.after, targetSquare).some(move => {
        play(ctx.after, move);
        const safe = !isPieceVulnerable(ctx.after, move.to);
        ctx.after.undo();
        return safe;
      });
      if (!safeMove) return theme("exploiting_pin", "Exploit a pin", `Attacks the pinned ${PIECE_NAMES[target.type]} on ${targetSquare}`, 10, [targetSquare]);
    }
  }
  for (const pawnSquare of ctx.after.attackers(ctx.move.to, ctx.opponentSide)) {
    const pawn = ctx.after.get(pawnSquare);
    if (pawn?.type !== "p" || !isAbsolutelyPinned(ctx.after, ctx.opponentSide, pawnSquare) || !pinnedBefore(ctx, pawnSquare)) continue;
    if (!canLegallyCapture(ctx.after, pawnSquare, ctx.move.to)) return theme("exploiting_pin", "Exploit a pin", `Uses the pinned pawn on ${pawnSquare}`, 10, [pawnSquare]);
  }
  if (!ctx.movedPieceIsHanging) for (const targetSquare of ctx.pieceAttacks) {
    const target = ctx.after.get(targetSquare);
    if (!target || target.color !== ctx.opponentSide || target.type === "p" || target.type === "k" || attackerValue > pieceValue(target)) continue;
    if (isAbsolutelyPinned(ctx.after, ctx.opponentSide, targetSquare)) continue;
    const relative = findRelativePin(ctx.after, targetSquare, ctx.movingSide, ctx.move.to);
    const beforeRelative = findRelativePin(ctx.before, targetSquare, ctx.movingSide);
    if (!relative || !beforeRelative) continue;
    const [, behindSquare] = relative;
    const safeEscape = legalMovesFrom(ctx.after, targetSquare).some(move => {
      play(ctx.after, move);
      const safe = !ctx.after.isAttacked(behindSquare, ctx.movingSide) && !isPieceVulnerable(ctx.after, move.to);
      ctx.after.undo();
      return safe;
    });
    if (!safeEscape) return theme("exploiting_pin", "Exploit a pin", `Attacks the relatively pinned ${PIECE_NAMES[target.type]} on ${targetSquare}`, 10, [targetSquare, behindSquare]);
  }
  return null;
}

export function recommendationsForThemes(themes: Array<TacticTheme | string> = []): LichessRecommendation[] {
  const unique = new Map<string, LichessRecommendation>();
  for (const value of themes) {
    const sourceTheme = typeof value === "string" ? value : value.id;
    const mapped = LICHESS_THEMES[sourceTheme];
    if (!mapped || unique.has(mapped.id)) continue;
    unique.set(mapped.id, { ...mapped, sourceTheme, url: `https://lichess.org/training/${mapped.id}` });
  }
  return [...unique.values()];
}

export function composeTacticTagline(themes: TacticTheme[]): string {
  if (!themes.length) return "Concrete best move";
  return [...themes].sort((left, right) => left.priority - right.priority)[0].phrase;
}

export function classifyTactic(fen: string, bestmove: string, options: { previousMove?: PreviousMoveContext } = {}): TacticClassification | null {
  if (!fen || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(bestmove || "")) return null;
  try {
    const ctx = new MoveContext(fen, bestmove);
    if (ctx.after.isCheckmate()) return null;
    const detected: Array<TacticTheme | null> = [
      detectDoubleCheck(ctx),
      detectFork(ctx),
      detectDiscoveredCheck(ctx),
      detectPin(ctx),
      detectSkewer(ctx),
      detectHangingCapture(ctx, options.previousMove),
      detectRemovingDefenderMaterial(ctx),
      detectRemovingDefenderMate(ctx),
      detectExploitingPin(ctx),
    ];
    if (!ctx.isCheck && !detected.some(Boolean)) detected.push(detectTrappedPiece(ctx));
    const themes = detected.filter((value): value is TacticTheme => Boolean(value)).sort((left, right) => left.priority - right.priority);
    if (!themes.length) return null;
    const themeIds = themes.map(item => item.id);
    return {
      san: ctx.move.san,
      fenAfter: ctx.after.fen(),
      themes,
      themeIds,
      motifIds: themeIds,
      tagline: composeTacticTagline(themes),
      recommendations: recommendationsForThemes(themes),
      analyzer: "chess_detect-ts",
      analyzerCommit: CHESS_DETECT_COMMIT,
    };
  } catch {
    return null;
  }
}

export function ensureTacticClassifier(): Promise<boolean> { return Promise.resolve(true); }

export function aggregateRecommendations(findings: Array<{ loss?: number; recommendations?: LichessRecommendation[] }> = []) {
  const totals = new Map<string, LichessRecommendation & { count: number; impact: number }>();
  for (const finding of findings) for (const recommendation of finding.recommendations || []) {
    const current = totals.get(recommendation.id) || { ...recommendation, count: 0, impact: 0 };
    current.count += 1;
    current.impact += Math.max(0, Number(finding.loss) || 0);
    totals.set(recommendation.id, current);
  }
  return [...totals.values()].sort((left, right) => right.count - left.count || right.impact - left.impact);
}
