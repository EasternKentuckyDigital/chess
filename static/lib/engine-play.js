import { Chess } from "../vendor/chess/chess.js";
import { replayConfig } from "../config.js";
import { createEngine } from "./engine-providers.js?v=20";
import { normalizePromotion, selectPromotionMove } from "./promotion.js";

const FILES = "abcdefgh";
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export const PLAY_ODDS = Object.freeze([
  { id: "standard", label: "Standard starting position", shortLabel: "No odds" },
  { id: "engine-knight", label: "Engine gives knight odds", shortLabel: "Knight odds", beneficiary: "human", piece: "n" },
  { id: "engine-rook", label: "Engine gives rook odds", shortLabel: "Rook odds", beneficiary: "human", piece: "r" },
  { id: "engine-queen", label: "Engine gives queen odds", shortLabel: "Queen odds", beneficiary: "human", piece: "q" },
  { id: "human-knight", label: "You give knight odds", shortLabel: "Give knight", beneficiary: "engine", piece: "n" },
  { id: "human-rook", label: "You give rook odds", shortLabel: "Give rook", beneficiary: "engine", piece: "r" },
  { id: "human-queen", label: "You give queen odds", shortLabel: "Give queen", beneficiary: "engine", piece: "q" },
]);

const ODDS_BY_ID = new Map(PLAY_ODDS.map(item => [item.id, item]));

function oddsSquare(color, piece) {
  const rank = color === "w" ? "1" : "8";
  return `${piece === "q" ? "d" : piece === "r" ? "a" : "b"}${rank}`;
}

export function createOddsPosition({ humanColor = "w", odds = "standard" } = {}) {
  const chess = new Chess();
  const preset = ODDS_BY_ID.get(odds) || ODDS_BY_ID.get("standard");
  if (!preset.piece) return chess;
  const engineColor = humanColor === "w" ? "b" : "w";
  const removedColor = preset.beneficiary === "human" ? engineColor : humanColor;
  chess.remove(oddsSquare(removedColor, preset.piece));
  if (preset.piece === "r") chess.setCastlingRights(removedColor, { q: false });
  return chess;
}

function engineDisplayName(id) {
  return id === "reckless" ? "Reckless (alpha)" : "Stockfish 18";
}

export function initEnginePlay({ getPieceSet, getTheme, getAnalysisLevel = () => "balanced", onSound, onSnapshot }) {
  const board = document.querySelector("#playBoard");
  const status = document.querySelector("#playStatus");
  const engineSelect = document.querySelector("#playEngine");
  const colorSelect = document.querySelector("#playColor");
  const oddsSelect = document.querySelector("#playOdds");
  const promotionSelect = document.querySelector("#playPromotion");
  const recklessOption = engineSelect.querySelector('option[value="reckless"]');
  if (!replayConfig.browserEngines?.reckless?.enabled) {
    recklessOption.disabled = true;
    recklessOption.textContent = "Reckless browser · unavailable";
  }

  const state = {
    chess: createOddsPosition({ humanColor: colorSelect.value, odds: oddsSelect.value }),
    rootFen: "",
    engine: null,
    engineId: engineSelect.value,
    humanColor: colorSelect.value,
    odds: oddsSelect.value,
    promotion: normalizePromotion(promotionSelect.value),
    selected: null,
    legal: [],
    busy: false,
    resigned: false,
    flipped: colorSelect.value === "b",
    startedAt: Date.now(),
    generation: 0,
    lastEngineDetail: "The engine starts after you make a move.",
  };
  state.rootFen = state.chess.fen();

  function layout() {
    return {
      ranks: state.flipped ? [1,2,3,4,5,6,7,8] : [8,7,6,5,4,3,2,1],
      files: state.flipped ? [...FILES].reverse() : [...FILES],
    };
  }

  function pieceImage(piece) {
    if (!piece) return "";
    return `./pieces/${getPieceSet()}/${piece.color}${piece.type.toUpperCase()}.svg`;
  }

  function materialFor(color) {
    return state.chess.board().flat().filter(Boolean).reduce((total, piece) => total + (piece.color === color ? PIECE_VALUES[piece.type] : 0), 0);
  }

  function renderNotation() {
    const history = state.chess.history({ verbose: true });
    const rows = [];
    for (let index = 0; index < history.length; index += 2) {
      rows.push(`<div class="play-notation-row"><span>${Math.floor(index / 2) + 1}.</span><strong>${history[index]?.san || ""}</strong><strong>${history[index + 1]?.san || ""}</strong></div>`);
    }
    document.querySelector("#playNotation").innerHTML = rows.join("") || "<p>No moves yet. Choose a piece or change the starting odds.</p>";
    requestAnimationFrame(() => document.querySelector("#playNotation .play-notation-row:last-child")?.scrollIntoView({ block: "nearest" }));
  }

  function updateGameInfo() {
    const history = state.chess.history({ verbose: true });
    const humanMaterial = materialFor(state.humanColor);
    const engineMaterial = materialFor(state.humanColor === "w" ? "b" : "w");
    const balance = humanMaterial - engineMaterial;
    const preset = ODDS_BY_ID.get(state.odds) || ODDS_BY_ID.get("standard");
    document.querySelector("#playMaterial").textContent = balance === 0 ? "Equal" : `${balance > 0 ? "+" : "−"}${Math.abs(balance)}`;
    document.querySelector("#playTurn").textContent = state.resigned ? "Game over" : state.chess.turn() === state.humanColor ? "Your turn" : `${engineDisplayName(state.engineId)} to move`;
    document.querySelector("#playPositionMeta").textContent = `${history.length} ${history.length === 1 ? "ply" : "plies"} · ${preset.shortLabel}`;
    document.querySelector("#playEngineDetail").textContent = state.lastEngineDetail;
    document.querySelector("#playUndoButton").disabled = !history.some(move => move.color === state.humanColor) || state.resigned;
    document.querySelector("#playResign").disabled = state.resigned || state.chess.isGameOver();
  }

  function render() {
    const { files, ranks } = layout();
    const last = state.chess.history({ verbose: true }).at(-1);
    board.innerHTML = ranks.flatMap((rank, row) => files.map((file, column) => {
      const square = `${file}${rank}`;
      const piece = state.chess.get(square);
      const dark = (FILES.indexOf(file) + rank) % 2 === 1;
      const legal = state.legal.find(move => move.to === square);
      return `<button type="button" class="square play-square ${dark ? "dark" : ""} ${state.selected === square ? "selected" : ""} ${legal ? `legal ${legal.captured ? "capture" : ""}` : ""} ${last && (last.from === square || last.to === square) ? "last" : ""}" data-play-square="${square}" aria-label="${square}${piece ? ` ${piece.color === "w" ? "white" : "black"} ${piece.type}` : ""}">
        ${column === 0 ? `<span class="coord rank">${rank}</span>` : ""}${row === 7 ? `<span class="coord file">${file}</span>` : ""}
        ${piece ? `<img class="piece-image" draggable="true" data-play-piece="${square}" src="${pieceImage(piece)}" alt="">` : ""}
      </button>`;
    })).join("");
    board.querySelectorAll("[data-play-square]").forEach(square => {
      square.addEventListener("click", () => chooseSquare(square.dataset.playSquare));
      square.addEventListener("dragover", event => event.preventDefault());
      square.addEventListener("drop", event => {
        event.preventDefault();
        const from = event.dataTransfer.getData("text/plain");
        if (from) attemptMove(from, square.dataset.playSquare);
      });
    });
    board.querySelectorAll("[data-play-piece]").forEach(piece => piece.addEventListener("dragstart", event => {
      event.dataTransfer.setData("text/plain", piece.dataset.playPiece);
    }));
    renderNotation();
    updateGameInfo();
  }

  function chooseSquare(square) {
    if (state.busy || state.resigned || state.chess.isGameOver() || state.chess.turn() !== state.humanColor) return;
    if (state.selected && state.legal.some(move => move.to === square)) return attemptMove(state.selected, square);
    const piece = state.chess.get(square);
    if (!piece || piece.color !== state.humanColor) {
      state.selected = null;
      state.legal = [];
    } else {
      state.selected = square;
      state.legal = state.chess.moves({ square, verbose: true });
    }
    render();
  }

  function attemptMove(from, to) {
    if (state.busy || state.resigned || state.chess.turn() !== state.humanColor) return false;
    const candidate = selectPromotionMove(state.chess.moves({ square: from, verbose: true }), to, state.promotion);
    if (!candidate) {
      chooseSquare(to);
      return false;
    }
    const move = state.chess.move({ from, to, promotion: candidate.promotion || state.promotion });
    state.selected = null;
    state.legal = [];
    state.lastEngineDetail = `You played ${move.san}. ${engineDisplayName(state.engineId)} is preparing a reply.`;
    onSound?.(move.captured ? "reveal" : "move");
    afterMove();
    return true;
  }

  function describeResult() {
    if (state.resigned) return "Game resigned. Start a new game when you are ready.";
    if (state.chess.isCheckmate()) return state.chess.turn() === state.humanColor ? "Checkmate — the engine wins." : "Checkmate — you win!";
    if (state.chess.isDraw()) return "Draw.";
    if (state.chess.inCheck() && state.chess.turn() === state.humanColor) return "Your king is in check.";
    return state.chess.turn() === state.humanColor ? "Your move." : "Engine thinking…";
  }

  function snapshot() {
    const history = state.chess.history();
    return {
      id: `${state.startedAt}:${state.engineId}:${state.odds}`,
      engine: state.engineId,
      humanColor: state.humanColor,
      odds: state.odds,
      promotion: state.promotion,
      rootFen: state.rootFen,
      startedAt: state.startedAt,
      updatedAt: Date.now(),
      fen: state.chess.fen(),
      pgn: state.chess.pgn(),
      moves: history.length,
      complete: state.resigned || state.chess.isGameOver(),
      result: state.resigned ? "resigned" : state.chess.isCheckmate() ? (state.chess.turn() === state.humanColor ? "loss" : "win") : state.chess.isDraw() ? "draw" : "active",
    };
  }

  function afterMove() {
    render();
    status.textContent = describeResult();
    onSnapshot?.(snapshot());
    if (!state.resigned && !state.chess.isGameOver() && state.chess.turn() !== state.humanColor) engineMove();
  }

  async function makeAdapter() {
    if (state.engineId === "reckless" && !replayConfig.browserEngines?.reckless?.enabled) {
      throw new Error("Reckless browser is unavailable on this deployment.");
    }
    const providerId = state.engineId === "reckless" ? "reckless-browser" : state.engineId === "stockfish" ? "stockfish-browser" : null;
    if (!providerId) throw new Error("That engine is not available in this deployment.");
    const engine = createEngine(providerId, { level: getAnalysisLevel() });
    const removeProgress = engine.onProgress?.(({ loaded = 0, total = null }) => {
      const loadedMiB = (loaded / (1024 * 1024)).toFixed(1);
      status.textContent = total
        ? `Downloading Reckless alpha · ${Math.round((loaded / total) * 100)}% (${loadedMiB} of ${(total / (1024 * 1024)).toFixed(1)} MiB)`
        : `Downloading Reckless alpha · ${loadedMiB} MiB received`;
    });
    try { await engine.init(); }
    finally { removeProgress?.(); }
    return {
      evaluate: fen => engine.evaluate(fen),
      close: () => engine.close(),
    };
  }

  async function engineMove() {
    const generation = state.generation;
    state.busy = true;
    status.textContent = `${engineDisplayName(state.engineId)} is thinking…`;
    render();
    try {
      if (!state.engine) state.engine = await makeAdapter();
      const result = await state.engine.evaluate(state.chess.fen());
      if (generation !== state.generation || state.resigned) return;
      const legalMoves = state.chess.moves({ verbose: true });
      const exact = legalMoves.find(move => `${move.from}${move.to}${move.promotion || ""}` === result.bestmove);
      const candidate = exact || selectPromotionMove(legalMoves.filter(move => move.from === result.bestmove?.slice(0, 2)), result.bestmove?.slice(2, 4), result.bestmove?.[4] || "q");
      if (!candidate) throw new Error("The engine did not return a legal move.");
      const played = state.chess.move(candidate);
      state.lastEngineDetail = `${engineDisplayName(state.engineId)} played ${played.san} · depth ${result.depth || "—"}`;
      onSound?.(played.captured ? "reveal" : "move");
    } catch (error) {
      if (generation !== state.generation) return;
      status.textContent = error.name === "AbortError" ? "Engine search cancelled." : error.message;
      state.engine?.close();
      state.engine = null;
      state.busy = false;
      render();
      return;
    } finally {
      if (generation === state.generation) state.busy = false;
    }
    if (generation === state.generation) afterMove();
  }

  function stopEngine() {
    state.generation += 1;
    state.engine?.close();
    state.engine = null;
    state.busy = false;
  }

  function reset() {
    stopEngine();
    state.engineId = engineSelect.value;
    state.humanColor = colorSelect.value;
    state.odds = oddsSelect.value;
    state.promotion = normalizePromotion(promotionSelect.value);
    state.chess = createOddsPosition({ humanColor: state.humanColor, odds: state.odds });
    state.rootFen = state.chess.fen();
    state.selected = null;
    state.legal = [];
    state.resigned = false;
    state.flipped = state.humanColor === "b";
    state.startedAt = Date.now();
    state.lastEngineDetail = state.engineId === "reckless"
      ? "Reckless is alpha software and may require a 61.5 MiB first-use download."
      : "Stockfish 18 runs locally in this browser.";
    afterMove();
  }

  function undoFullMove() {
    const history = state.chess.history({ verbose: true });
    if (!history.some(move => move.color === state.humanColor)) return;
    stopEngine();
    let removedHumanMove = false;
    while (state.chess.history().length) {
      const undone = state.chess.undo();
      if (undone?.color === state.humanColor) removedHumanMove = true;
      if (removedHumanMove && state.chess.turn() === state.humanColor) break;
    }
    state.resigned = false;
    state.selected = null;
    state.legal = [];
    state.lastEngineDetail = "The last full move was taken back.";
    render();
    status.textContent = describeResult();
    onSnapshot?.(snapshot());
  }

  engineSelect.addEventListener("change", reset);
  colorSelect.addEventListener("change", reset);
  oddsSelect.addEventListener("change", reset);
  promotionSelect.addEventListener("change", event => {
    state.promotion = normalizePromotion(event.currentTarget.value);
    state.lastEngineDetail = `Your pawns will promote to a ${event.currentTarget.selectedOptions[0].textContent.toLowerCase()}.`;
    render();
  });
  document.querySelector("#playNewGame").addEventListener("click", reset);
  document.querySelector("#playUndoButton").addEventListener("click", undoFullMove);
  document.querySelector("#playFlipButton").addEventListener("click", () => {
    state.flipped = !state.flipped;
    render();
  });
  document.querySelector("#playResign").addEventListener("click", () => {
    if (state.resigned || state.chess.isGameOver()) return;
    stopEngine();
    state.resigned = true;
    status.textContent = describeResult();
    state.lastEngineDetail = "You resigned this game.";
    onSnapshot?.(snapshot());
    render();
  });

  render();
  afterMove();
  return {
    refresh() {
      document.querySelector("#playBoardShell").className = `board-shell analysis-board-shell play-board-shell theme-${getTheme()}`;
      render();
    },
    resetEngine() { stopEngine(); },
    close() { stopEngine(); },
  };
}
