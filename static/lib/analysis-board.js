import { Chess } from "../vendor/chess/chess.js";
import { createBoardArrows } from "./board-arrows.js";
import { createEngine, engineDescriptor, isEngineCancellation } from "./engine-providers.js?v=21";
import { normalizePromotion, selectPromotionMove } from "./promotion.js";
import { centipawnLoss, sideToMoveScore } from "./engine-score.js";
import { renderEvaluationBar } from "./eval-bar.js";
import { classifyPuzzleEligibility } from "./puzzle-rules.js";
import { aggregateRecommendations, classifyTactic, ensureTacticClassifier } from "./chess-detect.js";

const PIECES = ["wK", "wQ", "wR", "wB", "wN", "wP", "bK", "bQ", "bR", "bB", "bN", "bP"];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function uci(move) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function findMove(chess, moveUci) {
  return chess.moves({ verbose: true }).find(move => uci(move) === moveUci || uci(move).slice(0, 4) === moveUci.slice(0, 4) && !moveUci[4]);
}

function sameMove(left, right) {
  if (!left || !right) return false;
  return left === right || left.slice(0, 4) === right.slice(0, 4) && (!left[4] || !right[4]);
}

function sanForMove(fen, moveUci) {
  try { return findMove(new Chess(fen), moveUci)?.san || moveUci || "—"; }
  catch { return moveUci || "—"; }
}

function resultText(result, fen) {
  const whiteFactor = fen.split(" ")[1] === "w" ? 1 : -1;
  if (result.mate !== null) {
    if (result.mate === 0) return "Mate";
    const mate = result.mate * whiteFactor;
    return mate > 0 ? `M${mate}` : `−M${Math.abs(mate)}`;
  }
  const pawns = ((result.cp || 0) * whiteFactor) / 100;
  return `${pawns >= 0 ? "+" : "−"}${Math.abs(pawns).toFixed(2)}`;
}

function engineTacticFallback(result) {
  if (result?.mate !== null && result.mate > 0) return {
    tagline: "Forced mating line",
    motifIds: ["checkmate"],
    recommendations: [{ id: "mate", label: "Checkmate", advice: "Calculate checks and forced replies until the king has no escape.", url: "https://lichess.org/training/mate" }],
    analyzer: "engine-fallback",
  };
  const promotion = result?.bestmove?.[4];
  if (promotion) return {
    tagline: promotion === "q" ? "Promotion tactic" : "Underpromotion tactic",
    motifIds: [promotion === "q" ? "promotion" : "underPromotion"],
    recommendations: [{ id: promotion === "q" ? "promotion" : "underPromotion", label: promotion === "q" ? "Promotion" : "Underpromotion", advice: "Calculate every promotion choice and its forcing consequences.", url: `https://lichess.org/training/${promotion === "q" ? "promotion" : "underPromotion"}` }],
    analyzer: "engine-fallback",
  };
  return null;
}

function moveAccuracy(loss) {
  if (!Number.isFinite(loss) || loss >= 5000) return 0;
  return Math.max(0, Math.min(100, 100 * Math.exp(-Math.max(0, loss) / 400)));
}

function pvToSan(fen, pv) {
  const chess = new Chess(fen);
  const line = [];
  for (const moveUci of pv.slice(0, 12)) {
    const move = findMove(chess, moveUci);
    if (!move) break;
    line.push(move.san);
    chess.move({ from: move.from, to: move.to, promotion: move.promotion });
  }
  return line.join(" ");
}

export function initAnalysisBoard({ getPieceSet, getEngineProvider, getAnalysisLevel = () => "balanced", onSound = () => {}, onPracticePuzzles = () => {} }) {
  const $ = selector => document.querySelector(selector);
  const initialReviewColor = $("#analysisPerspective").value === "b" ? "b" : "w";
  const state = {
    chess: new Chess(),
    rootFen: new Chess().fen(),
    selectedSquare: null,
    legalMoves: [],
    editorPiece: "wQ",
    editing: false,
    flipped: initialReviewColor === "b",
    moves: [],
    cursor: 0,
    headers: {},
    sourceGame: null,
    reviewColor: initialReviewColor,
    moveAnalyses: [],
    findings: [],
    puzzles: [],
    positionAnalyses: new Map(),
    accuracyRunning: false,
    accuracyRunToken: 0,
    accuracyEngine: null,
    engine: null,
    engineProvider: null,
    liveEngine: false,
    analyzing: false,
    analysisQueued: false,
    analysisRevision: 0,
    pointerDrag: null,
    suppressClick: false,
    promotion: normalizePromotion($("#analysisPromotion").value),
  };
  let arrows = null;

  function progressText({ loaded = 0, total = null }) {
    const loadedMiB = (loaded / (1024 * 1024)).toFixed(1);
    if (!total) return `${loadedMiB} MiB of the Reckless engine downloaded…`;
    return `Downloading Reckless · ${Math.round((loaded / total) * 100)}% (${loadedMiB} of ${(total / (1024 * 1024)).toFixed(1)} MiB)`;
  }

  function cancelAnalysis(message = "Analysis cancelled.") {
    state.analysisRevision += 1;
    state.analysisQueued = state.liveEngine;
    state.engine?.close();
    state.engine = null;
    state.engineProvider = null;
    if (state.analyzing) $("#analysisEngineResult").textContent = message;
  }

  function pieceUrl(piece) {
    return new URL(`../pieces/${getPieceSet()}/${piece}.svg`, import.meta.url).href;
  }

  function renderPalette() {
    $("#analysisPalette").innerHTML = `${PIECES.map(piece => `<button type="button" data-editor-piece="${piece}" class="${state.editorPiece === piece ? "active" : ""}" aria-label="Place ${piece}"><img src="${pieceUrl(piece)}" alt=""></button>`).join("")}<button type="button" data-editor-piece="erase" class="erase ${state.editorPiece === "erase" ? "active" : ""}">Erase</button>`;
    $("#analysisPalette").querySelectorAll("[data-editor-piece]").forEach(button => button.addEventListener("click", () => {
      state.editorPiece = button.dataset.editorPiece;
      renderPalette();
    }));
  }

  function accuracyClass(value) {
    if (value >= 90) return "excellent";
    if (value >= 70) return "good";
    if (value >= 45) return "inaccuracy";
    return "mistake";
  }

  function notationButton(move, ply) {
    if (!move) return `<span class="analysis-move-empty"></span>`;
    const analysis = state.moveAnalyses[ply - 1];
    const accuracy = analysis ? `<small class="move-accuracy ${accuracyClass(analysis.accuracy)}">${analysis.accuracy.toFixed(0)}</small>` : "";
    return `<button type="button" class="analysis-move ${state.cursor === ply ? "current" : ""}" data-analysis-ply="${ply}" ${state.cursor === ply ? 'aria-current="move"' : ""} title="Go to ${move.san}${analysis ? ` · ${analysis.accuracy.toFixed(1)}% DoBackChess accuracy · ${Math.round(analysis.loss)} cp loss` : ""}"><span>${move.san}</span>${accuracy}</button>`;
  }

  function renderMoveNavigation() {
    const move = state.cursor ? state.moves[state.cursor - 1] : null;
    $("#analysisFirstMoveButton").disabled = state.cursor === 0;
    $("#analysisPreviousMoveButton").disabled = state.cursor === 0;
    $("#analysisNextMoveButton").disabled = state.cursor >= state.moves.length;
    $("#analysisLastMoveButton").disabled = state.cursor >= state.moves.length;
    $("#analysisMoveStatus").textContent = move ? `${state.cursor} / ${state.moves.length} · ${move.san}` : `Start · ${state.moves.length} moves`;
    const white = state.headers.White || "White";
    const black = state.headers.Black || "Black";
    $("#analysisGameTitle").textContent = state.moves.length ? `${white} – ${black}` : "Move list";
  }

  function renderNotation() {
    const fenParts = state.rootFen.split(" ");
    let color = fenParts[1] === "b" ? "b" : "w";
    let moveNumber = Number(fenParts[5]) || 1;
    const rows = new Map();
    state.moves.forEach((move, index) => {
      const row = rows.get(moveNumber) || { white: "", black: "" };
      if (color === "w") row.white = { move, ply: index + 1 };
      else row.black = { move, ply: index + 1 };
      rows.set(moveNumber, row);
      if (color === "b") moveNumber += 1;
      color = color === "w" ? "b" : "w";
    });
    const html = [...rows].map(([number, row]) => `<div><span>${number}.</span>${notationButton(row.white?.move, row.white?.ply)}${notationButton(row.black?.move, row.black?.ply)}</div>`).join("");
    $("#analysisNotation").innerHTML = html || `<p>Play moves or import PGN to build notation.</p>`;
    $("#analysisNotation").querySelectorAll("[data-analysis-ply]").forEach(button => button.addEventListener("click", () => setCursor(Number(button.dataset.analysisPly))));
    $("#analysisAccuracyButton").disabled = !state.moves.length && !state.accuracyRunning;
    renderMoveNavigation();
    renderMoveExplanation();
  }

  function renderMoveExplanation() {
    const panel = $("#analysisMoveExplanation");
    if (!panel) return;
    if (!state.moves.length) {
      panel.innerHTML = `<span>Selected move</span><strong>Load or play a game first.</strong><p>Past games, PGN imports, and moves played on the board can all receive the same local review.</p>`;
      return;
    }
    if (!state.cursor) {
      panel.innerHTML = `<span>Starting position</span><strong>No move selected.</strong><p>Choose a move in the notation after review to see what was played, the engine's best move, and any available tactic.</p>`;
      return;
    }
    const move = state.moves[state.cursor - 1];
    const analysis = state.moveAnalyses[state.cursor - 1];
    if (!analysis) {
      panel.innerHTML = `<span>Move ${state.cursor} · ${escapeHtml(move.san)}</span><strong>Not analyzed yet.</strong><p>Choose <em>Review game</em>; results appear here as each move finishes.</p>`;
      return;
    }
    const foundBest = sameMove(analysis.played, analysis.bestmove);
    const quality = foundBest ? "Best move" : analysis.loss >= 300 ? "Blunder" : analysis.loss >= 150 ? "Mistake" : analysis.loss >= 80 ? "Inaccuracy" : "Playable move";
    const tactic = analysis.positional;
    const tacticText = tactic
      ? `${foundBest ? "Tactic found" : "Tactic available"}: ${tactic.tagline}`
      : foundBest ? "The engine agrees with this move; no named tactic was required." : "No named tactic cleared the classifier rules; the engine preferred a concrete improvement.";
    const links = tactic?.recommendations?.length
      ? `<div class="move-explanation-links">${tactic.recommendations.slice(0, 3).map(item => `<a href="${item.url}" target="_blank" rel="noreferrer">${escapeHtml(item.label)} puzzles ↗</a>`).join("")}</div>`
      : "";
    panel.innerHTML = `<span>Move ${analysis.moveNumber} · ${escapeHtml(move.san)} · ${quality}</span><strong>${escapeHtml(tacticText)}</strong><p>Played <b>${escapeHtml(move.san)}</b> · best <b>${escapeHtml(analysis.bestSan)}</b> · ${Math.round(analysis.loss)} cp loss · evaluation ${escapeHtml(analysis.playedEval)} instead of ${escapeHtml(analysis.bestEval)}.</p>${analysis.bestPv ? `<small>Best line: ${escapeHtml(analysis.bestPv)}</small>` : ""}${links}`;
  }

  function moveNumberAt(index) {
    const fields = state.rootFen.split(" ");
    const firstTurnOffset = fields[1] === "b" ? 1 : 0;
    return (Number(fields[5]) || 1) + Math.floor((index + firstTurnOffset) / 2);
  }

  function rebuildPosition(ply) {
    const chess = new Chess(state.rootFen);
    for (const move of state.moves.slice(0, ply)) {
      const legal = findMove(chess, move.uci);
      if (!legal) throw new Error(`Could not restore move ${move.san}.`);
      chess.move({ from: legal.from, to: legal.to, promotion: legal.promotion });
    }
    state.chess = chess;
  }

  function renderBoard(lastMove = null) {
    const files = state.flipped ? ["h","g","f","e","d","c","b","a"] : ["a","b","c","d","e","f","g","h"];
    const ranks = state.flipped ? [1,2,3,4,5,6,7,8] : [8,7,6,5,4,3,2,1];
    const targets = new Map(state.legalMoves.map(move => [move.to, move]));
    const last = lastMove ? [lastMove.slice(0, 2), lastMove.slice(2, 4)] : [];
    const html = [];
    ranks.forEach((rank, row) => files.forEach((file, column) => {
      const square = `${file}${rank}`;
      const piece = state.chess.get(square);
      const pieceName = piece ? `${piece.color}${piece.type.toUpperCase()}` : null;
      const dark = ((file.charCodeAt(0) - 97) + rank) % 2 === 1;
      const legal = targets.get(square);
      html.push(`<button type="button" class="square analysis-square ${dark ? "dark" : ""} ${state.selectedSquare === square ? "selected" : ""} ${legal ? `legal ${legal.captured ? "capture" : ""}` : ""} ${last.includes(square) ? "last" : ""}" data-analysis-square="${square}" aria-label="${square}">
        ${column === 0 ? `<span class="coord rank">${rank}</span>` : ""}${row === 7 ? `<span class="coord file">${file}</span>` : ""}
        ${pieceName ? `<img class="piece-image" src="${pieceUrl(pieceName)}" alt="" draggable="false">` : ""}
      </button>`);
    }));
    $("#analysisBoard").innerHTML = html.join("");
    $("#analysisBoard").querySelectorAll("[data-analysis-square]").forEach(button => button.addEventListener("click", () => handleSquare(button.dataset.analysisSquare)));
    $("#analysisBoard").querySelectorAll(".piece-image").forEach(piece => piece.addEventListener("pointerdown", startPointerDrag));
    $("#analysisFen").value = state.chess.fen();
    $("#analysisTurn").value = state.chess.turn();
    const turn = state.chess.turn();
    $("#analysisTurnIndicator").textContent = `${turn === "b" ? "Black" : "White"} to move`;
    $("#analysisTurnIndicator").classList.toggle("black", turn === "b");
    $("#analysisTurnIndicator").classList.toggle("white", turn === "w");
    const saved = state.positionAnalyses.get(state.cursor);
    renderEvaluationBar($("#analysisEvalBar"), saved?.result || null, saved?.fen || state.chess.fen(), state.flipped);
    renderNotation();
    arrows?.refresh();
  }

  function resetMoveSelection() {
    state.selectedSquare = null;
    state.legalMoves = [];
  }

  function hasValidKings() {
    const kings = state.chess.board().flat().filter(piece => piece?.type === "k");
    return kings.filter(piece => piece.color === "w").length === 1 && kings.filter(piece => piece.color === "b").length === 1;
  }

  function displayEngineResult(result, fen, status) {
    $("#analysisEngineEval").textContent = resultText(result, fen);
    $("#analysisEngineLine").textContent = pvToSan(fen, result.pv) || result.bestmove || "—";
    $("#analysisEngineResult").textContent = status;
    renderEvaluationBar($("#analysisEvalBar"), result, fen, state.flipped);
  }

  function showSavedPositionAnalysis() {
    const saved = state.positionAnalyses.get(state.cursor);
    if (!saved) return false;
    const engineName = saved.engineName || engineDescriptor(getEngineProvider()).name;
    displayEngineResult(saved.result, saved.fen, `${engineName} · saved depth ${saved.result.depth || "—"} · White perspective`);
    return true;
  }

  function clearGameAnalysis() {
    if (state.accuracyRunning) state.accuracyRunToken += 1;
    state.moveAnalyses = [];
    state.findings = [];
    state.puzzles = [];
    state.positionAnalyses.clear();
    $("#analysisAccuracySummary").classList.add("hidden");
    $("#analysisAccuracySummary").innerHTML = "";
    $("#analysisAccuracyProgress").classList.add("hidden");
    $("#analysisAccuracyProgress span").style.width = "0%";
    $("#analysisAccuracyNote").textContent = "Click any move to revisit that position. Accuracy is measured locally from engine loss.";
    $("#analysisEngineEval").textContent = "—";
    $("#analysisEngineLine").textContent = "—";
    renderMoveExplanation();
    renderInsights();
    renderEvaluationBar($("#analysisEvalBar"), null, state.chess.fen(), state.flipped);
  }

  function reviewDetail() {
    const chess = new Chess(state.rootFen);
    const frames = [{ fen: chess.fen() }];
    const moves = [];
    state.moves.forEach((move, index) => {
      const legal = findMove(chess, move.uci);
      if (!legal) return;
      const played = chess.move({ from: legal.from, to: legal.to, promotion: legal.promotion });
      moves.push({ ply: index + 1, uci: move.uci, san: played.san, fen: chess.fen() });
      frames.push({ fen: chess.fen() });
    });
    return { frames, moves, headers: { ...state.headers } };
  }

  function analysisGame() {
    if (state.sourceGame) return { ...state.sourceGame };
    const black = state.headers.Black || "Black";
    const headerDate = state.headers.Date || "";
    const id = `analysis:${state.rootFen}:${state.moves.map(move => move.uci).join("-")}`;
    return {
      id,
      playerColor: "white",
      opponent: black,
      date: headerDate && !headerDate.startsWith("?") ? headerDate : "Imported game",
      timeClass: "Analysis",
      result: state.headers.Result || "*",
      opening: state.headers.Opening || "Imported game",
      url: "",
    };
  }

  function studiedColor() {
    return state.reviewColor;
  }

  function reviewMoveRow(item, detail, action = "Show move") {
    const move = item.move || state.moves[item.ply - 1];
    return `<button type="button" class="review-move-row" data-review-ply="${item.ply}"><span class="review-move-number">${item.moveNumber}${item.color === "b" ? "…" : "."}</span><span><b>${escapeHtml(move?.san || item.playedSan || "Move")}</b><small>${escapeHtml(detail)}</small></span><span class="review-move-loss">${item.loss >= 80 ? `−${(item.loss / 100).toFixed(1)}` : "✓"}</span><span class="review-move-action">${action} ›</span></button>`;
  }

  function renderInsights() {
    const panel = $("#analysisInsights");
    if (!panel) return;
    const player = studiedColor();
    const playerLabel = player === "w" ? (state.headers.White || "White") : (state.headers.Black || "Black");
    const opponentLabel = player === "w" ? (state.headers.Black || "Black") : (state.headers.White || "White");
    const mistakes = state.moveAnalyses
      .map((analysis, index) => analysis ? { ...analysis, ply: index + 1, move: state.moves[index] } : null)
      .filter(item => item?.color === player && item.loss >= 80);
    const missed = state.findings.filter(finding => finding.color === player);
    const usedAgainst = state.moveAnalyses
      .map((analysis, index) => analysis ? { ...analysis, ply: index + 1, move: state.moves[index] } : null)
      .filter(item => item?.color !== player && item.positional && sameMove(item.played, item.bestmove));
    if (!missed.length && !mistakes.length && !usedAgainst.length) {
      const reviewed = state.moveAnalyses.some(Boolean);
      panel.innerHTML = `<div class="analysis-card-heading"><div><span class="panel-kicker">Tactics from this game</span><h2>What to work on</h2></div><span>chess_detect</span></div><p>${reviewed ? `No ${escapeHtml(playerLabel)} move lost 0.8 pawns or more, and no named tactic cleared the classifier rules.` : "Review the game to see tactics you missed, tactics used against you, and direct links to the matching moves and Lichess practice."}</p>`;
      return;
    }
    const recommendations = aggregateRecommendations(missed);
    const themes = recommendations.length
      ? recommendations.map((item, themeIndex) => {
        const matching = missed.filter(finding => finding.recommendations?.some(recommendation => recommendation.id === item.id));
        const moves = matching.map(finding => reviewMoveRow(finding, finding.tagline)).join("");
        return `<section class="analysis-theme-group"><button type="button" class="analysis-theme-toggle" data-review-theme="${themeIndex}" aria-expanded="false"><span class="tactic-theme-icon">!</span><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.advice)}</small></span><b>${item.count}</b><span class="theme-toggle-action">Moves ›</span></button><div class="analysis-theme-moves hidden" data-review-theme-moves="${themeIndex}">${moves}<a class="theme-practice-link" href="${item.url}" target="_blank" rel="noreferrer">Practice tagged ${escapeHtml(item.label.toLowerCase())} puzzles on Lichess ↗</a></div></section>`;
      }).join("")
      : `<p class="analysis-insights-empty">No named tactic was missed; review the costly moves below for concrete improvements.</p>`;
    const mistakeRows = mistakes
      .sort((left, right) => right.loss - left.loss)
      .map(item => {
        const quality = item.loss >= 300 ? "Blunder" : item.loss >= 150 ? "Mistake" : "Inaccuracy";
        const tactic = item.positional?.tagline || "Concrete engine improvement";
        return reviewMoveRow(item, `${quality} · ${tactic}`);
      }).join("");
    const usedRows = usedAgainst.map(item => {
      const motif = item.positional.recommendations?.[0];
      return `${reviewMoveRow(item, `${opponentLabel} found ${item.positional.tagline}`, "Replay")}${motif ? `<a class="used-tactic-practice" href="${motif.url}" target="_blank" rel="noreferrer">Practice ${escapeHtml(motif.label.toLowerCase())} puzzles ↗</a>` : ""}`;
    }).join("");
    panel.innerHTML = `<div class="analysis-card-heading"><div><span class="panel-kicker">Tactics from this game</span><h2>What to work on</h2></div><strong>${escapeHtml(playerLabel)} perspective</strong></div><div class="analysis-review-stats"><div><strong>${missed.length}</strong><span>tactics missed</span></div><div><strong>${mistakes.length}</strong><span>costly moves</span></div><div><strong>${usedAgainst.length}</strong><span>used against you</span></div></div><div class="analysis-review-section"><div class="review-section-heading"><div><span class="panel-kicker">You missed</span><h3>Opportunities to recognize sooner</h3></div><span>${missed.length}</span></div><div class="analysis-theme-groups">${themes}</div></div><div class="analysis-review-section"><div class="review-section-heading"><div><span class="panel-kicker">Used against you</span><h3>Tactics ${escapeHtml(opponentLabel)} found</h3></div><span>${usedAgainst.length}</span></div><div class="analysis-used-list">${usedRows || `<p class="analysis-insights-empty">No named tactic by ${escapeHtml(opponentLabel)} matched the engine's best move.</p>`}</div></div><div class="analysis-review-section"><div class="review-section-heading"><div><span class="panel-kicker">Your mistakes</span><h3>Every costly move</h3></div><span>${mistakes.length}</span></div><div class="analysis-mistake-list">${mistakeRows || `<p class="analysis-insights-empty">No ${escapeHtml(playerLabel)} move lost 0.8 pawns or more.</p>`}</div></div>${state.puzzles.length ? `<button id="analysisPracticeButton" class="primary-button full-button" type="button">Practice important positions from this game</button>` : ""}`;
    panel.querySelectorAll("[data-review-theme]").forEach(button => button.addEventListener("click", () => {
      const moves = panel.querySelector(`[data-review-theme-moves="${button.dataset.reviewTheme}"]`);
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!expanded));
      button.querySelector(".theme-toggle-action").textContent = expanded ? "Moves ›" : "Close ×";
      moves.classList.toggle("hidden", expanded);
    }));
    panel.querySelectorAll("[data-review-ply]").forEach(button => button.addEventListener("click", () => {
      setCursor(Number(button.dataset.reviewPly));
    }));
    $("#analysisPracticeButton")?.addEventListener("click", () => onPracticePuzzles({ puzzles: state.puzzles, game: analysisGame(), detail: reviewDetail() }));
  }

  function positionChanged(message = "Position changed") {
    state.analysisRevision += 1;
    if (state.liveEngine) {
      if (state.analyzing) {
        state.analysisQueued = true;
        state.engine?.close();
        state.engine = null;
        state.engineProvider = null;
      }
      $("#analysisEngineResult").textContent = `${message} · engine queued…`;
      requestAnalysis();
    } else if (!showSavedPositionAnalysis()) $("#analysisEngineResult").textContent = `${message} · engine is paused.`;
  }

  function setCursor(ply) {
    const nextCursor = Math.max(0, Math.min(state.moves.length, ply));
    try {
      rebuildPosition(nextCursor);
      state.cursor = nextCursor;
      resetMoveSelection();
      arrows.clear();
      renderBoard(nextCursor ? state.moves[nextCursor - 1].uci : null);
      positionChanged(nextCursor ? `Position after ${state.moves[nextCursor - 1].san}` : "Starting position");
    } catch (error) {
      $("#analysisBoardError").textContent = error.message;
    }
  }

  function editSquare(square) {
    cancelAnalysis("Position changed — analysis cancelled.");
    if (state.editorPiece === "erase") state.chess.remove(square);
    else if (!state.chess.put({ color: state.editorPiece[0], type: state.editorPiece[1].toLowerCase() }, square)) {
      $("#analysisBoardError").textContent = "A position can contain only one king of each color.";
      return;
    }
    $("#analysisBoardError").textContent = "";
    state.rootFen = state.chess.fen();
    state.moves = [];
    state.cursor = 0;
    state.headers = {};
    state.sourceGame = null;
    clearGameAnalysis();
    resetMoveSelection();
    arrows.clear();
    renderBoard();
    positionChanged("Edited position");
  }

  function attemptMove(from, to) {
    if (state.editing) return false;
    const candidate = selectPromotionMove(state.chess.moves({ square: from, verbose: true }), to, state.promotion);
    if (!candidate) return false;
    if (state.cursor < state.moves.length) state.moves = state.moves.slice(0, state.cursor);
    const played = state.chess.move({ from, to, promotion: candidate.promotion || state.promotion });
    state.moves.push({ san: played.san, uci: uci(played) });
    state.cursor = state.moves.length;
    clearGameAnalysis();
    resetMoveSelection();
    arrows.clear();
    onSound("move");
    renderBoard(uci(played));
    positionChanged();
    return true;
  }

  function handleSquare(square) {
    if (state.suppressClick) return;
    if (state.editing) return editSquare(square);
    const piece = state.chess.get(square);
    if (!state.selectedSquare) {
      if (!piece || piece.color !== state.chess.turn()) return;
      state.selectedSquare = square;
      state.legalMoves = state.chess.moves({ square, verbose: true });
      return renderBoard();
    }
    if (square === state.selectedSquare) {
      resetMoveSelection();
      return renderBoard();
    }
    if (state.legalMoves.some(move => move.to === square)) return attemptMove(state.selectedSquare, square);
    if (piece?.color === state.chess.turn()) {
      state.selectedSquare = square;
      state.legalMoves = state.chess.moves({ square, verbose: true });
    } else resetMoveSelection();
    renderBoard();
  }

  function startPointerDrag(event) {
    if (state.editing || event.button !== 0 || event.shiftKey) return;
    const square = event.currentTarget.closest(".analysis-square")?.dataset.analysisSquare;
    const piece = square && state.chess.get(square);
    if (!piece || piece.color !== state.chess.turn()) return;
    state.pointerDrag = { from: square, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, source: event.currentTarget, dragging: false, ghost: null };
  }

  function movePointerDrag(event) {
    const drag = state.pointerDrag;
    if (!drag) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.dragging && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 6) {
      drag.dragging = true;
      state.selectedSquare = drag.from;
      state.legalMoves = state.chess.moves({ square: drag.from, verbose: true });
      drag.source.classList.add("dragging");
      drag.ghost = drag.source.cloneNode(true);
      drag.ghost.className = "drag-ghost";
      const size = drag.source.getBoundingClientRect().width;
      drag.ghost.style.width = `${size}px`;
      drag.ghost.style.height = `${size}px`;
      document.body.appendChild(drag.ghost);
      for (const move of state.legalMoves) {
        const target = $("#analysisBoard").querySelector(`[data-analysis-square="${move.to}"]`);
        target?.classList.add("legal");
        if (move.captured) target?.classList.add("capture");
      }
      $("#analysisBoard").querySelector(`[data-analysis-square="${drag.from}"]`)?.classList.add("selected");
    }
    if (drag.dragging) {
      event.preventDefault();
      drag.ghost.style.left = `${drag.x}px`;
      drag.ghost.style.top = `${drag.y}px`;
      $("#analysisBoard").querySelectorAll(".drag-over").forEach(square => square.classList.remove("drag-over"));
      const target = document.elementFromPoint(drag.x, drag.y)?.closest(".analysis-square");
      if (target && state.legalMoves.some(move => move.to === target.dataset.analysisSquare)) target.classList.add("drag-over");
    }
  }

  function endPointerDrag(event) {
    const drag = state.pointerDrag;
    if (!drag) return;
    state.pointerDrag = null;
    if (!drag.dragging) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".analysis-square");
    drag.ghost?.remove();
    drag.source?.classList.remove("dragging");
    state.suppressClick = true;
    const moved = target && attemptMove(drag.from, target.dataset.analysisSquare);
    if (!moved) {
      resetMoveSelection();
      renderBoard();
    }
    setTimeout(() => { state.suppressClick = false; }, 80);
  }

  function loadFen(value) {
    try {
      const nextPosition = new Chess(value.trim());
      cancelAnalysis("Position changed — analysis cancelled.");
      state.chess = nextPosition;
      state.rootFen = state.chess.fen();
      state.moves = [];
      state.cursor = 0;
      state.headers = {};
      state.sourceGame = null;
      clearGameAnalysis();
      resetMoveSelection();
      arrows.clear();
      renderBoard();
      $("#analysisBoardError").textContent = "";
      positionChanged("FEN loaded");
    } catch (error) {
      $("#analysisBoardError").textContent = error.message || "Enter a valid FEN position.";
    }
  }

  function loadPgn(value, { sourceGame = null, closeDialog = true } = {}) {
    try {
      const source = value.trim();
      if (!source) throw new Error("Paste PGN text or choose a PGN file first.");
      const loaded = new Chess();
      loaded.loadPgn(source);
      const headers = loaded.getHeaders();
      state.rootFen = headers.FEN ? new Chess(headers.FEN).fen() : new Chess().fen();
      state.moves = loaded.history({ verbose: true }).map(move => ({ san: move.san, uci: uci(move) }));
      state.cursor = state.moves.length;
      state.headers = headers;
      state.sourceGame = sourceGame;
      if (sourceGame?.playerColor === "black" || sourceGame?.playerColor === "b") state.reviewColor = "b";
      else if (sourceGame?.playerColor === "white" || sourceGame?.playerColor === "w") state.reviewColor = "w";
      $("#analysisPerspective").value = state.reviewColor;
      state.flipped = state.reviewColor === "b";
      clearGameAnalysis();
      state.chess = loaded;
      resetMoveSelection();
      arrows.clear();
      renderBoard(state.moves.at(-1)?.uci || null);
      $("#analysisPgnError").textContent = "";
      if (closeDialog && $("#analysisPgnDialog").open) $("#analysisPgnDialog").close();
      positionChanged("PGN loaded");
      onSound("move");
      return true;
    } catch (error) {
      const message = error.message || "That PGN could not be loaded.";
      if (closeDialog) $("#analysisPgnError").textContent = message;
      else $("#analysisBoardError").textContent = message;
      return false;
    }
  }

  async function ensureEngine(descriptor) {
    if (state.engine && state.engineProvider === descriptor.id) return state.engine;
    state.engine?.close();
    state.engine = createEngine(descriptor.id, { level: getAnalysisLevel() });
    state.engineProvider = descriptor.id;
    const removeProgress = state.engine.onProgress?.(progress => {
      $("#analysisEngineResult").textContent = progressText(progress);
    });
    try { await state.engine.init(); }
    finally { removeProgress?.(); }
    return state.engine;
  }

  function requestAnalysis() {
    if (!state.liveEngine) return;
    if (state.analyzing) {
      state.analysisQueued = true;
      return;
    }
    analyze();
  }

  async function analyze() {
    if (!state.liveEngine || state.analyzing) return;
    state.analyzing = true;
    state.analysisQueued = false;
    const revision = state.analysisRevision;
    const descriptor = engineDescriptor(getEngineProvider());
    $("#analysisEngineResult").textContent = `${descriptor.name} is thinking…`;
    try {
      if (!hasValidKings()) throw new Error("Add exactly one white king and one black king before analysis.");
      const engine = await ensureEngine(descriptor);
      const fen = state.chess.fen();
      const result = await engine.evaluate(fen);
      if (!state.liveEngine || revision !== state.analysisRevision) {
        state.analysisQueued = state.liveEngine;
        return;
      }
      state.positionAnalyses.set(state.cursor, { result, fen, engineName: descriptor.name });
      displayEngineResult(result, fen, `${descriptor.name} · depth ${result.depth || "—"} · White perspective`);
    } catch (error) {
      if (state.liveEngine && !isEngineCancellation(error)) $("#analysisEngineResult").textContent = error.message || "Analysis failed.";
    } finally {
      state.analyzing = false;
      if (!state.liveEngine) {
        state.engine?.close();
        state.engine = null;
        state.engineProvider = null;
      } else if (state.analysisQueued || revision !== state.analysisRevision) requestAnalysis();
    }
  }

  function toggleEngine() {
    state.liveEngine = !state.liveEngine;
    state.analysisRevision += 1;
    $("#analyzePositionButton").classList.toggle("active", state.liveEngine);
    $("#analyzePositionButton").textContent = state.liveEngine ? "Stop engine" : "Start engine";
    if (state.liveEngine) requestAnalysis();
    else {
      state.analysisQueued = false;
      $("#analysisEngineResult").textContent = "Engine is paused.";
      state.engine?.close();
      state.engine = null;
      state.engineProvider = null;
    }
  }

  function renderAccuracySummary() {
    const analyses = state.moveAnalyses.filter(Boolean);
    const summary = $("#analysisAccuracySummary");
    if (!analyses.length) {
      summary.classList.add("hidden");
      return;
    }
    const average = color => {
      const moves = analyses.filter(item => item.color === color);
      return moves.length ? moves.reduce((sum, item) => sum + item.accuracy, 0) / moves.length : null;
    };
    const white = average("w");
    const black = average("b");
    const whiteName = state.headers.White || "White";
    const blackName = state.headers.Black || "Black";
    summary.innerHTML = `<div><span>${escapeHtml(whiteName)}</span><strong>${white === null ? "—" : `${white.toFixed(1)}%`}</strong></div><div><span>${escapeHtml(blackName)}</span><strong>${black === null ? "—" : `${black.toFixed(1)}%`}</strong></div>`;
    summary.classList.remove("hidden");
  }

  async function waitForLiveAnalysisToStop(token) {
    while (state.analyzing && token === state.accuracyRunToken) await new Promise(resolve => setTimeout(resolve, 80));
  }

  async function measureAccuracy() {
    if (!state.moves.length || state.accuracyRunning) return;
    if (state.liveEngine) toggleEngine();
    clearGameAnalysis();
    state.accuracyRunning = true;
    const token = ++state.accuracyRunToken;
    const button = $("#analysisAccuracyButton");
    const engineButton = $("#analyzePositionButton");
    const progress = $("#analysisAccuracyProgress");
    const progressBar = $("#analysisAccuracyProgress span");
    button.disabled = false;
    button.textContent = "Stop measurement";
    engineButton.disabled = true;
    progress.classList.remove("hidden");
    progressBar.style.width = "0%";
    $("#analysisAccuracyNote").textContent = "Preparing the selected engine…";
    const descriptor = engineDescriptor(getEngineProvider());
    let accuracyEngine = null;
    try {
      await waitForLiveAnalysisToStop(token);
      if (token !== state.accuracyRunToken) return;
      accuracyEngine = createEngine(descriptor.id, { level: getAnalysisLevel() });
      state.accuracyEngine = accuracyEngine;
      await Promise.all([accuracyEngine.init(), ensureTacticClassifier()]);
      const chess = new Chess(state.rootFen);
      const totalEvaluations = state.moves.length * 2 + 1;
      let completed = 0;
      for (let index = 0; index < state.moves.length; index += 1) {
        if (token !== state.accuracyRunToken) break;
        const move = state.moves[index];
        const beforeFen = chess.fen();
        const color = chess.turn();
        $("#analysisAccuracyNote").textContent = `${descriptor.name} · measuring move ${index + 1} of ${state.moves.length}`;
        const best = await accuracyEngine.evaluate(beforeFen);
        completed += 1;
        state.positionAnalyses.set(index, { result: best, fen: beforeFen, engineName: descriptor.name });
        progressBar.style.width = `${Math.round((completed / totalEvaluations) * 100)}%`;
        if (token !== state.accuracyRunToken) break;
        const played = await accuracyEngine.evaluate(beforeFen, move.uci);
        completed += 1;
        const loss = centipawnLoss(best, played);
        const prior = state.moves[index - 1];
        const previousMove = prior ? { from: prior.uci.slice(0, 2), to: prior.uci.slice(2, 4), wasCapture: prior.san.includes("x") } : undefined;
        const positional = classifyTactic(beforeFen, best.bestmove, { previousMove }) || engineTacticFallback(best);
        const bestSan = positional?.san || sanForMove(beforeFen, best.bestmove);
        const finding = loss >= 80 && positional ? {
          ...positional,
          ply: index + 1,
          loss,
          moveNumber: moveNumberAt(index),
          color,
          played: move.uci,
          playedSan: move.san,
          bestSan,
        } : null;
        if (finding) state.findings.push(finding);
        const eligibility = classifyPuzzleEligibility({
          bestValue: sideToMoveScore(best),
          playedValue: sideToMoveScore(played),
          bestMate: best.mate,
          playedMate: played.mate,
        });
        if (eligibility.eligible) {
          const game = analysisGame();
          state.puzzles.push({
            id: `${game.id}:${index + 1}:${eligibility.category.toLowerCase().replaceAll(" ", "-")}`,
            gameId: game.id,
            ply: index + 1,
            moveNumber: moveNumberAt(index),
            fen: beforeFen,
            category: eligibility.category,
            loss: Math.min(eligibility.loss, 100000),
            impact: Math.min(eligibility.loss, 100000),
            best: best.bestmove,
            bestSan,
            bestEval: resultText(best, beforeFen),
            bestPv: pvToSan(beforeFen, best.pv),
            played: move.uci,
            playedSan: move.san,
            playedEval: resultText(played, beforeFen),
            bestResult: { cp: best.cp, mate: best.mate },
            engineName: descriptor.name,
            positionalTagline: positional?.tagline || "Concrete best move",
            positionalMotifs: positional?.motifIds || [],
            lichessRecommendations: positional?.recommendations || [],
            game: {
              ...game,
              playerColor: color === "w" ? "white" : "black",
              opponent: color === "w" ? (state.headers.Black || "Black") : (state.headers.White || "White"),
            },
          });
        }
        state.moveAnalyses[index] = {
          color,
          loss,
          accuracy: moveAccuracy(loss),
          moveNumber: moveNumberAt(index),
          bestmove: best.bestmove,
          bestSan,
          bestEval: resultText(best, beforeFen),
          playedEval: resultText(played, beforeFen),
          bestPv: pvToSan(beforeFen, best.pv),
          played: move.uci,
          positional,
        };
        const legal = findMove(chess, move.uci);
        if (!legal) throw new Error(`Move ${move.san} is no longer legal from the imported position.`);
        chess.move({ from: legal.from, to: legal.to, promotion: legal.promotion });
        progressBar.style.width = `${Math.round((completed / totalEvaluations) * 100)}%`;
        renderAccuracySummary();
        renderInsights();
        renderNotation();
        if (state.cursor === index) showSavedPositionAnalysis();
      }
      if (token === state.accuracyRunToken) {
        const finalFen = chess.fen();
        const finalResult = await accuracyEngine.evaluate(finalFen);
        state.positionAnalyses.set(state.moves.length, { result: finalResult, fen: finalFen, engineName: descriptor.name });
        progressBar.style.width = "100%";
        renderAccuracySummary();
        renderNotation();
        if (!state.liveEngine) showSavedPositionAnalysis();
        $("#analysisAccuracyNote").textContent = `DoBackChess accuracy uses ${descriptor.name} centipawn loss: 100 × e^(−loss ÷ 400). Click a move to see its saved evaluation.`;
        state.puzzles.sort((left, right) => right.impact - left.impact);
        renderInsights();
      }
    } catch (error) {
      if (token === state.accuracyRunToken) $("#analysisAccuracyNote").textContent = error.message || "Accuracy measurement failed.";
    } finally {
      accuracyEngine?.close();
      if (state.accuracyEngine === accuracyEngine) state.accuracyEngine = null;
      const stopped = token !== state.accuracyRunToken;
      state.accuracyRunning = false;
      button.textContent = "Review game";
      button.disabled = !state.moves.length;
      engineButton.disabled = false;
      progress.classList.add("hidden");
      if (stopped && state.moves.length) $("#analysisAccuracyNote").textContent = "Accuracy measurement stopped. Run it again when ready.";
    }
  }

  $("#analysisEditButton").addEventListener("click", () => {
    state.editing = !state.editing;
    if (state.editing && state.liveEngine) toggleEngine();
    $("#analysisEditButton").classList.toggle("active", state.editing);
    $("#analysisEditButton").textContent = state.editing ? "Finish editing" : "Edit position";
    $("#analysisEditor").classList.toggle("hidden", !state.editing);
    $(".engine-analysis-card").classList.toggle("hidden", state.editing);
    $(".notation-analysis-card").classList.toggle("hidden", state.editing);
    if (!state.editing) {
      state.rootFen = state.chess.fen();
      state.moves = [];
      state.cursor = 0;
      state.headers = {};
      state.sourceGame = null;
      clearGameAnalysis();
      positionChanged("Edited position");
    }
    resetMoveSelection();
    arrows.clear();
    renderBoard();
  });
  $("#analysisResetButton").addEventListener("click", () => {
    cancelAnalysis("Position reset — analysis cancelled.");
    state.chess = new Chess();
    state.rootFen = state.chess.fen();
    state.moves = [];
    state.cursor = 0;
    state.headers = {};
    state.sourceGame = null;
    clearGameAnalysis();
    resetMoveSelection();
    arrows.clear();
    onSound("move");
    renderBoard();
    positionChanged("Starting position");
  });
  $("#analysisUndoButton").addEventListener("click", () => {
    if (!state.cursor) return;
    state.moves = state.moves.slice(0, state.cursor - 1);
    state.cursor = state.moves.length;
    rebuildPosition(state.cursor);
    clearGameAnalysis();
    resetMoveSelection();
    arrows.clear();
    onSound("move");
    renderBoard();
    positionChanged("Move undone");
  });
  $("#analysisFlipButton").addEventListener("click", () => { state.flipped = !state.flipped; renderBoard(); });
  $("#analysisFirstMoveButton").addEventListener("click", () => setCursor(0));
  $("#analysisPreviousMoveButton").addEventListener("click", () => setCursor(state.cursor - 1));
  $("#analysisNextMoveButton").addEventListener("click", () => setCursor(state.cursor + 1));
  $("#analysisLastMoveButton").addEventListener("click", () => setCursor(state.moves.length));
  $("#analysisPerspective").addEventListener("change", event => {
    state.reviewColor = event.currentTarget.value === "b" ? "b" : "w";
    state.flipped = state.reviewColor === "b";
    renderBoard(state.cursor ? state.moves[state.cursor - 1]?.uci : null);
    renderInsights();
  });
  $("#analysisClearButton").addEventListener("click", () => {
    cancelAnalysis("Position changed — analysis cancelled.");
    state.chess.clear();
    state.rootFen = state.chess.fen();
    state.moves = [];
    state.cursor = 0;
    state.headers = {};
    state.sourceGame = null;
    clearGameAnalysis();
    resetMoveSelection();
    arrows.clear();
    renderBoard();
    positionChanged("Board cleared");
  });
  $("#analysisLoadFenButton").addEventListener("click", () => loadFen($("#analysisFen").value));
  $("#analysisTurn").addEventListener("change", event => {
    const parts = state.chess.fen().split(" ");
    parts[1] = event.currentTarget.value;
    loadFen(parts.join(" "));
  });
  $("#analysisPromotion").addEventListener("change", event => {
    state.promotion = normalizePromotion(event.currentTarget.value);
  });
  $("#analysisPgnButton").addEventListener("click", () => {
    $("#analysisPgnError").textContent = "";
    $("#analysisPgnDialog").showModal();
  });
  $("#analysisPgnFile").addEventListener("change", async event => {
    const file = event.currentTarget.files?.[0];
    if (file) $("#analysisPgnInput").value = await file.text();
  });
  $("#analysisLoadPgnButton").addEventListener("click", () => loadPgn($("#analysisPgnInput").value));
  $("#analyzePositionButton").addEventListener("click", toggleEngine);
  $("#analysisAccuracyButton").addEventListener("click", () => {
    if (state.accuracyRunning) {
      state.accuracyRunToken += 1;
      $("#analysisAccuracyButton").textContent = "Stopping…";
      $("#analysisAccuracyNote").textContent = "Stopping after the current engine search…";
    } else measureAccuracy();
  });
  document.addEventListener("pointermove", movePointerDrag, { passive: false });
  document.addEventListener("pointerup", endPointerDrag, { passive: false });
  document.addEventListener("pointercancel", endPointerDrag, { passive: false });

  arrows = createBoardArrows({
    board: $("#analysisBoard"),
    svg: $("#analysisArrows"),
    squareSelector: ".analysis-square",
    squareData: "analysisSquare",
    isFlipped: () => state.flipped,
  });
  renderPalette();
  renderBoard();
  return {
    refresh() { renderPalette(); renderBoard(); if (state.liveEngine) positionChanged("Engine changed"); },
    loadPgn(value, game = null) { return loadPgn(value, { sourceGame: game, closeDialog: false }); },
    async analyzePgn(value, game = null) {
      if (state.accuracyRunning) {
        state.accuracyRunToken += 1;
        state.accuracyEngine?.close();
        state.accuracyEngine = null;
        while (state.accuracyRunning) await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!loadPgn(value, { sourceGame: game, closeDialog: false })) return false;
      await measureAccuracy();
      return true;
    },
    cancel() {
      cancelAnalysis("Engine changed — analysis cancelled.");
      if (state.accuracyRunning) {
        state.accuracyRunToken += 1;
        state.accuracyEngine?.close();
        state.accuracyEngine = null;
      }
    },
    close() {
      state.liveEngine = false;
      state.engine?.close();
      state.accuracyEngine?.close();
      arrows.destroy();
      document.removeEventListener("pointermove", movePointerDrag);
      document.removeEventListener("pointerup", endPointerDrag);
      document.removeEventListener("pointercancel", endPointerDrag);
    },
  };
}
