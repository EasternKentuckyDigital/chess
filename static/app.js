import { Chess } from "./vendor/chess/chess.js";
import { DEFAULT_REPORT_GAMES, exportImportedGames, importGames, importPgnText, getGameDetail as buildGameDetail, normalizeReportGameLimit, reportSelectionCount, restoreImportedGames } from "./lib/game-import.js?v=21";
import { ANALYSIS_LEVELS, analysisLimits, createEngine, engineDescriptor, engineDescriptors, engineFingerprint, isEngineCancellation, normalizeAnalysisLevel } from "./lib/engine-providers.js?v=21";
import { activateDeviceProfile, clearProfileSession, continueAsGuest, listDeviceProfiles, restoreProfileSession } from "./lib/profile-store.js";
import { classifyPuzzleEligibility } from "./lib/puzzle-rules.js";
import { createBoardArrows } from "./lib/board-arrows.js";
import { FEATURED_MASTERS, fetchGrandmasterHandles } from "./lib/masters.js";
import { initAnalysisBoard } from "./lib/analysis-board.js?v=24";
import { cloudConfigured, createEmailAccount, initCloudSession, loadCloudJson, queueCloudJson, sendEmailPasswordReset, signInOrLink, signInWithEmail, signOutCloud } from "./lib/auth-sync.js";
import { initEnginePlay } from "./lib/engine-play.js?v=21";
import { buildChessReport } from "./lib/chess-report.js?v=24";
import { sideToMoveScore } from "./lib/engine-score.js";
import { renderEvaluationBar } from "./lib/eval-bar.js";
import { resolveSiteTheme } from "./lib/theme.js?v=21";
import { retainedLibraryRecords } from "./lib/library-storage.js?v=21";

const ANALYSIS_VERSION = 13;
const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_PREFS = {
  siteTheme: "system",
  theme: "brown",
  pieces: "cburnett",
  effectsEnabled: true,
  masterVolume: .65,
  engineProvider: "stockfish-browser",
  analysisLevel: "superquick",
  reportGameLimit: DEFAULT_REPORT_GAMES,
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const assetUrl = path => new URL(path, import.meta.url).href;
const systemColorScheme = globalThis.matchMedia?.("(prefers-color-scheme: dark)") || null;

const state = {
  appUser: null,
  guest: false,
  username: "",
  displayName: "",
  source: "chesscom",
  scope: "recent",
  games: [],
  window: "Last 7 days",
  selectedIds: new Set(),
  details: new Map(),
  puzzles: [],
  current: null,
  puzzleChess: null,
  selectedSquare: null,
  legalMoves: [],
  phase: "idle",
  prefs: { ...DEFAULT_PREFS },
  sessionSeen: new Set(),
  analyzing: false,
  analysisEngine: null,
  analysisCancelled: false,
  reportAbortController: null,
  reportAbortMode: null,
  reviewReport: null,
  reviewGames: [],
  pointerDrag: null,
  suppressClick: false,
  practiceEngine: null,
  practiceEnginePromise: null,
  practiceQueue: Promise.resolve(),
  wrongEvalToken: 0,
  audioContext: null,
  grandmasters: [],
};

let generalAnalysisBoard = null;
let enginePlay = null;
let grandmastersLoading = null;
let trainingArrowLayer = null;
let lastCloudUserId = null;
let pgnImportTarget = "deck";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function identityKey() { return state.appUser?.id || "guest"; }
function analysisKey() { return `replay:analysis:${state.source}:${state.username.toLowerCase()}`; }
function scheduleKey() { return `replay:schedule:${identityKey()}:${state.source}:${state.username.toLowerCase()}`; }
function prefsKey() { return `replay:prefs:${identityKey()}`; }
function canUseEngine(provider) { return provider.configured && provider.local; }
function engineLimitText(provider) {
  const limits = analysisLimits(state.prefs.analysisLevel);
  return provider.id === "reckless-browser" ? `${limits.recklessNodes.toLocaleString()} nodes` : `depth ${limits.stockfishDepth}`;
}
function downloadProgressText({ loaded = 0, total = null }) {
  const loadedMiB = (loaded / (1024 * 1024)).toFixed(1);
  if (!total) return `Downloading Reckless engine · ${loadedMiB} MiB received`;
  return `Downloading Reckless engine · ${Math.round((loaded / total) * 100)}% (${loadedMiB} of ${(total / (1024 * 1024)).toFixed(1)} MiB)`;
}
function libraryKey(source = state.source, username = state.username) { return `replay:library:${identityKey()}:${source}:${username.toLowerCase()}`; }
function playedGamesKey() { return `replay:played-games:${identityKey()}`; }
function reportKey(mode, source, username) { return `replay:report:${mode}:${identityKey()}:${source}:${username.toLowerCase()}`; }
function limitedSavedRecords(records, scope) {
  const gameLimit = normalizeReportGameLimit(state.prefs.reportGameLimit);
  if (scope === "recent" || scope === "report") {
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    return records.slice(0, reportSelectionCount(records, record => record.summary?.endTime, cutoff, gameLimit));
  }
  if (scope === "wrapped") return records.slice(0, gameLimit);
  if (scope === "latest") return records.slice(0, 20);
  if (scope === "latest100") return records.slice(0, 100);
  return records;
}

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { showToast("Browser storage is full; this session will still work."); }
  queueCloudJson(key, value);
}

async function persistGameLibrary({ data, username, source, scope }) {
  const key = libraryKey(source, username);
  const previous = await loadCloudJson(key, loadJson(key, null));
  const records = retainedLibraryRecords(exportImportedGames(), previous?.records, {
    cloud: state.appUser?.storage === "cloud",
  });
  saveJson(key, {
    games: data.games,
    window: data.window,
    scope,
    savedAt: Date.now(),
    records,
  });
  return records.length;
}

$("#importForm").addEventListener("submit", async event => {
  event.preventDefault();
  const source = $("#gameSource").value;
  if (source === "pgn") {
    openTournamentImport("deck");
    return;
  }
  const username = $("#username").value.trim();
  const button = event.currentTarget.querySelector("button");
  await startStudy(username, source, "recent", username, button);
});

async function activateStudyData({ data, username, source, scope = "recent", displayName = username }) {
  if (!data.games.length) throw new Error(data.emptyMessage || "No games were found for this deck.");
  state.username = username;
  state.displayName = displayName;
  state.source = source;
  state.scope = scope;
  state.games = data.games;
  state.window = data.window;
  state.details.clear();
  state.selectedIds = new Set(data.games.map(game => game.id));
  if (source !== "pgn") localStorage.setItem("replay:last-user", username);
  const cloudSchedule = await loadCloudJson(scheduleKey(), null);
  if (cloudSchedule) localStorage.setItem(scheduleKey(), JSON.stringify(cloudSchedule));
  enterTrainer();
  if (data.notice) showToast(data.notice);
  await buildDeck();
}

async function startStudy(username, source, scope = "recent", displayName = username, button = null) {
  $("#heroError").textContent = "";
  const fromMasters = !$("#mastersPage").classList.contains("hidden");
  if (button) button.disabled = true;
  const buttonLabel = button?.querySelector("span:first-child");
  const originalButtonLabel = buttonLabel?.textContent;
  if (buttonLabel) buttonLabel.textContent = "Loading games…";
  try {
    let data;
    try {
      data = await importGames({ username, source, scope, gameLimit: state.prefs.reportGameLimit });
      await persistGameLibrary({ data, username, source, scope });
    } catch (importError) {
      const localSaved = loadJson(libraryKey(source, username), null);
      const saved = await loadCloudJson(libraryKey(source, username), localSaved);
      if (!saved?.records?.length) throw importError;
      const games = restoreImportedGames(limitedSavedRecords(saved.records, scope));
      data = { games, window: `${saved.window || "Saved games"} · offline copy` };
      showToast("The game service was unavailable, so DoBackChess opened your saved games.");
    }
    await activateStudyData({ data, username, source, scope, displayName });
  } catch (error) {
    if (fromMasters) {
      showMasters();
      showToast(error.message);
    } else {
      $("#heroError").textContent = error.message;
      goHome();
    }
  } finally {
    if (button) button.disabled = false;
    if (buttonLabel) buttonLabel.textContent = originalButtonLabel || "Build deck";
  }
}

function enterTrainer() {
  document.body.classList.add("puzzle-room");
  document.body.classList.remove("analysis-room", "play-room");
  hideMainViews();
  $("#trainer").classList.remove("hidden");
  setActiveNav("review");
  $("#deckTitle").textContent = `${state.displayName || state.username}'s mistake`;
  $("#gameWindow").textContent = state.window;
  $("#gamesCount").textContent = state.games.length;
  applyPreferences();
  renderGamePicker();
  updateStats();
}

function setActiveNav(name) {
  $$(".nav-item").forEach(item => item.classList.toggle("active", item.id === `nav${name[0].toUpperCase()}${name.slice(1)}`));
}

function hideMainViews() {
  for (const id of ["hero", "mastersPage", "analysisPage", "playPage", "reportPage", "tacticsReportPage", "aboutPage", "trainer"]) $(`#${id}`).classList.add("hidden");
}

function goHome() {
  showAnalysis();
}

function showMasters() {
  document.body.classList.remove("puzzle-room", "analysis-room", "play-room");
  hideMainViews();
  $("#mastersPage").classList.remove("hidden");
  setActiveNav("masters");
  loadGrandmasterDirectory();
}

function showAnalysis() {
  document.body.classList.remove("puzzle-room", "play-room");
  document.body.classList.add("analysis-room");
  hideMainViews();
  $("#analysisPage").classList.remove("hidden");
  setActiveNav("analysis");
  if (!generalAnalysisBoard) {
    generalAnalysisBoard = initAnalysisBoard({
      getPieceSet: () => state.prefs.pieces,
      getEngineProvider: () => state.prefs.engineProvider,
      getAnalysisLevel: () => state.prefs.analysisLevel,
      onSound: playSound,
      onPracticePuzzles: openAnalysisPractice,
    });
  } else generalAnalysisBoard.refresh();
  applyPreferences();
}

function showPlay() {
  document.body.classList.remove("puzzle-room", "analysis-room");
  document.body.classList.add("play-room");
  hideMainViews();
  $("#playPage").classList.remove("hidden");
  setActiveNav("play");
  if (!enginePlay) {
    enginePlay = initEnginePlay({
      getPieceSet: () => state.prefs.pieces,
      getTheme: () => state.prefs.theme,
      getAnalysisLevel: () => state.prefs.analysisLevel,
      onSound: playSound,
      onSnapshot: savePlayedGame,
    });
  }
  enginePlay.refresh();
}

async function showReport() {
  document.body.classList.remove("puzzle-room", "analysis-room", "play-room");
  hideMainViews();
  $("#reportPage").classList.remove("hidden");
  setActiveNav("report");
  await loadSavedReport("wrapped");
}

async function showTacticsReport() {
  document.body.classList.remove("puzzle-room", "analysis-room", "play-room");
  hideMainViews();
  $("#tacticsReportPage").classList.remove("hidden");
  setActiveNav("review");
  await loadSavedReport("tactics");
}

function showAbout() {
  document.body.classList.remove("puzzle-room", "analysis-room", "play-room");
  hideMainViews();
  $("#aboutPage").classList.remove("hidden");
  setActiveNav("about");
}

function savePlayedGame(game) {
  const key = playedGamesKey();
  const games = loadJson(key, []);
  const index = games.findIndex(item => item.id === game.id);
  if (index >= 0) games[index] = game;
  else games.unshift(game);
  saveJson(key, games.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50));
}

const REPORT_SURFACES = Object.freeze({
  wrapped: Object.freeze({
    label: "Chess Report",
    form: "#reportForm",
    source: "#reportSource",
    username: "#reportUsername",
    scope: "#reportScopeText",
    error: "#reportError",
    results: "#reportResults",
    progress: "#reportProgress",
    progressText: "#reportProgressText",
    progressBar: "#reportProgressBar",
    stop: "#stopReportButton",
  }),
  tactics: Object.freeze({
    label: "Game review",
    form: "#tacticsReportForm",
    source: "#tacticsReportSource",
    username: "#tacticsReportUsername",
    scope: "#tacticsReportScopeText",
    error: "#tacticsReportError",
    results: "#tacticsReportResults",
    progress: "#tacticsReportProgress",
    progressText: "#tacticsReportProgressText",
    progressBar: "#tacticsReportProgressBar",
    stop: "#stopTacticsReportButton",
  }),
});

function reportSurface(mode) { return REPORT_SURFACES[mode] || REPORT_SURFACES.wrapped; }

async function loadSavedReport(mode) {
  const ui = reportSurface(mode);
  const username = $(ui.username).value.trim();
  const source = $(ui.source).value;
  if (!username || source === "pgn") return;
  const key = reportKey(mode, source, username);
  const saved = await loadCloudJson(key, loadJson(key, null));
  if (saved) (mode === "tactics" ? renderTacticsReport : renderChessReport)(saved);
}

function bindReportForm(mode) {
  const ui = reportSurface(mode);
  $(ui.form).addEventListener("submit", async event => {
    event.preventDefault();
    const username = $(ui.username).value.trim();
    const source = $(ui.source).value;
    if (source === "pgn") {
      openTournamentImport(mode === "tactics" ? "tactics-report" : "report");
      return;
    }
    await runReportAnalysis({ mode, username, source, button: event.currentTarget.querySelector("button") });
  });
}

bindReportForm("wrapped");
bindReportForm("tactics");

async function runReportAnalysis({ mode = "wrapped", username, source, importedGames = null, button = null }) {
  if (state.reportAbortController) return showToast("Stop the current report before starting another one.");
  const ui = reportSurface(mode);
  const controller = new AbortController();
  state.reportAbortController = controller;
  state.reportAbortMode = mode;
  if (button) button.disabled = true;
  $(ui.error).textContent = "";
  $(ui.results).classList.add("hidden");
  $(ui.progress).classList.remove("hidden");
  $(ui.stop).disabled = false;
  $(ui.progressBar).style.width = "0%";
  try {
    let selectedGames = importedGames;
    if (!selectedGames) {
      try {
        selectedGames = await importGames({ username, source, scope: mode === "wrapped" ? "wrapped" : "report", gameLimit: state.prefs.reportGameLimit });
      } catch (importError) {
        const key = libraryKey(source, username);
        const saved = await loadCloudJson(key, loadJson(key, null));
        if (!saved?.records?.length) throw importError;
        const reportRecords = limitedSavedRecords(saved.records, mode === "wrapped" ? "wrapped" : "report");
        const games = restoreImportedGames(reportRecords);
        selectedGames = { games, window: `${saved.window || "Saved games"} · persistent copy` };
        showToast(`The game service was unavailable, so DoBackChess opened ${games.length} saved games.`);
      }
    }
    const retained = await persistGameLibrary({ data: selectedGames, username, source, scope: mode === "tactics" ? "tactics-report" : "report" });
    const analyzedGames = selectedGames.games.slice(0, state.prefs.reportGameLimit);
    if (mode === "tactics") state.reviewGames = analyzedGames;
    if (mode === "tactics" && selectedGames.games.length > analyzedGames.length) {
      showToast(`Imported ${selectedGames.games.length} recent games; Tactics Report will analyze the newest ${analyzedGames.length}. Increase the report count in Settings for more history.`);
    } else if (selectedGames.notice) showToast(selectedGames.notice);
    const report = await buildChessReport({
      username,
      source,
      importedGames: { ...selectedGames, games: analyzedGames },
      analysisLevel: state.prefs.analysisLevel,
      gameLimit: state.prefs.reportGameLimit,
      reportMode: mode === "tactics" ? "combined" : mode,
      signal: controller.signal,
      onProgress: progress => {
        $(ui.progressText).textContent = `Game ${progress.game} of ${progress.games} · move ${progress.move} of ${progress.moves}`;
        $(ui.progressBar).style.width = `${Math.round(((progress.game - 1) / progress.games + progress.move / progress.moves / progress.games) * 100)}%`;
      },
    });
    report.retainedGames = retained;
    saveJson(reportKey(mode, source, username), report);
    (mode === "tactics" ? renderTacticsReport : renderChessReport)(report);
  } catch (error) {
    if (controller.signal.aborted || isEngineCancellation(error)) showToast(`${ui.label} analysis stopped.`);
    else $(ui.error).textContent = error.message || `The ${ui.label} could not be completed.`;
  } finally {
    if (button) button.disabled = false;
    $(ui.progress).classList.add("hidden");
    if (state.reportAbortController === controller) {
      state.reportAbortController = null;
      state.reportAbortMode = null;
    }
  }
}

function stopReportAnalysis(mode) {
  if (!state.reportAbortController || state.reportAbortMode !== mode) return;
  const ui = reportSurface(mode);
  $(ui.progressText).textContent = "Stopping analysis…";
  $(ui.stop).disabled = true;
  state.reportAbortController.abort();
}

$("#stopReportButton").addEventListener("click", () => stopReportAnalysis("wrapped"));
$("#stopTacticsReportButton").addEventListener("click", () => stopReportAnalysis("tactics"));

function openTournamentImport(target) {
  pgnImportTarget = target;
  const isWrapped = target === "report";
  const isTactics = target === "tactics-report";
  $("#trainingPgnTitle").textContent = isWrapped ? "Build a Chess Report from PGN" : isTactics ? "Review games from PGN" : "Build a deck from PGN";
  $("#trainingPgnDescription").textContent = isWrapped
    ? "Upload one or more real tournament games, or paste complete PGN/SAN notation for a private recent-form summary."
    : isTactics
      ? "Upload one or more games, or paste complete PGN/SAN notation to review mistakes, detect themes, and create practice positions."
      : "Upload one or more real tournament games, or paste PGN/SAN notation such as 1. e4 e5 2. Nf3 Nc6.";
  $("#loadTrainingPgnButton").textContent = isWrapped ? "Build Chess Report" : isTactics ? "Review games" : "Build training deck";
  $("#trainingPgnError").textContent = "";
  if (!$("#trainingPgnDialog").open) $("#trainingPgnDialog").showModal();
}

$("#trainingPgnFile").addEventListener("change", async event => {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  try {
    $("#trainingPgnInput").value = await file.text();
    $("#trainingPgnError").textContent = "";
  } catch {
    $("#trainingPgnError").textContent = "That file could not be read. Try pasting its PGN text instead.";
  }
});

$("#loadTrainingPgnButton").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  $("#trainingPgnError").textContent = "";
  try {
    const data = await importPgnText({
      text: $("#trainingPgnInput").value,
      playerName: $("#trainingPgnPlayer").value,
      fallbackColor: $("#trainingPgnColor").value,
    });
    const username = data.playerName || "Imported player";
    if (pgnImportTarget === "report" || pgnImportTarget === "tactics-report") {
      const mode = pgnImportTarget === "tactics-report" ? "tactics" : "wrapped";
      const ui = reportSurface(mode);
      $("#trainingPgnDialog").close();
      await runReportAnalysis({ mode, username, source: "pgn", importedGames: data, button: $(`${ui.form} button`) });
    } else {
      await persistGameLibrary({ data, username, source: "pgn", scope: "uploaded" });
      $("#trainingPgnDialog").close();
      await activateStudyData({ data, username, source: "pgn", scope: "uploaded", displayName: username });
    }
  } catch (error) {
    $("#trainingPgnError").textContent = error.message || "Those games could not be imported.";
  } finally {
    button.disabled = false;
  }
});

function renderChessReport(report) {
  const wrapped = report.wrapped;
  $("#chessWrapped").classList.toggle("hidden", !wrapped || wrapped.averageAccuracy === null);
  if (wrapped && wrapped.averageAccuracy !== null) {
    $("#wrappedAccuracy").textContent = `${wrapped.averageAccuracy.toFixed(1)}%`;
    $("#wrappedGames").textContent = wrapped.games;
    $("#wrappedMoves").textContent = wrapped.moves.toLocaleString();
    $("#wrappedRecord").textContent = `${wrapped.wins} wins · ${wrapped.draws} draws · ${wrapped.losses} losses`;
    $("#wrappedDescription").textContent = `Average move accuracy across your latest ${wrapped.games} analyzed ${wrapped.games === 1 ? "game" : "games"}, using your ${report.gameLimit}-game report setting.`;
  }
  $("#reportResults").classList.remove("hidden");
}

function renderTacticsReport(report) {
  state.reviewReport = report;
  $("#tacticsReportGames").textContent = report.games;
  $("#tacticsReportAccuracy").textContent = report.wrapped?.averageAccuracy === null || report.wrapped?.averageAccuracy === undefined ? "—" : `${report.wrapped.averageAccuracy.toFixed(1)}%`;
  $("#tacticsReportPositions").textContent = report.positions.toLocaleString();
  $("#tacticsReportMistakes").textContent = report.mistakes;
  $("#reviewPuzzleCount").textContent = report.puzzles?.length || 0;
  $("#practiceReviewPuzzles").disabled = !report.puzzles?.length;
  $("#tacticsReportRecommendations").innerHTML = report.recommendations.length ? report.recommendations.map((item, index) => `<article class="report-card ${index === 0 ? "top-theme" : ""}"><span class="report-count">${item.count}</span><div><span class="panel-kicker">${index === 0 ? "Top priority" : "Practice theme"}</span><h3>${escapeHtml(item.label)}</h3><p>${escapeHtml(item.advice)}</p><a href="${item.url}" target="_blank" rel="noreferrer">Practice tagged ${escapeHtml(item.label.toLowerCase())} puzzles on Lichess ↗</a></div></article>`).join("") : `<p class="report-empty">No named chess_detect tactic cleared the report threshold. Your own large-loss positions are still available above.</p>`;
  $("#tacticsReportExamples").innerHTML = report.examples.length ? report.examples.map(example => `<article><span class="category">${escapeHtml(example.label)}</span><strong>vs ${escapeHtml(example.opponent)}</strong><small>${escapeHtml(example.date)} · ${escapeHtml(example.consequence || `lost ${(example.loss / 100).toFixed(1)} pawns`)}</small><p>${escapeHtml(example.tagline || "Concrete best move")}</p><code>${escapeHtml(example.fen)}</code></article>`).join("") : `<p class="report-empty">No costly examples were found.</p>`;
  $("#tacticsReportResults").classList.remove("hidden");
}

function openAnalysisPractice({ puzzles, game, detail }) {
  if (!puzzles?.length) return showToast("Review the game first so there are practice positions to open.");
  state.username = "analysis-board";
  state.displayName = "Analysis board";
  state.source = "pgn";
  state.window = "Single-game review";
  state.games = [game];
  state.selectedIds = new Set([game.id]);
  state.details.clear();
  state.details.set(game.id, detail);
  state.puzzles = [...puzzles];
  state.current = null;
  state.sessionSeen.clear();
  enterTrainer();
  showNextPuzzle();
}

async function openReviewPractice() {
  const report = state.reviewReport;
  if (!report?.puzzles?.length) return showToast("Complete a review with at least one important missed position first.");
  let games = state.reviewGames;
  if (!games.length) {
    const saved = await loadCloudJson(libraryKey(report.source, report.username), loadJson(libraryKey(report.source, report.username), null));
    if (saved?.records?.length) games = restoreImportedGames(saved.records);
  }
  const puzzleGameIds = new Set(report.puzzles.map(puzzle => puzzle.gameId));
  state.username = report.username;
  state.displayName = report.username;
  state.source = report.source;
  state.window = `${report.games}-game review`;
  state.games = games.filter(game => puzzleGameIds.has(game.id));
  if (!state.games.length) state.games = [...new Map(report.puzzles.map(puzzle => [puzzle.game.id, puzzle.game])).values()];
  state.selectedIds = new Set(state.games.map(game => game.id));
  state.details.clear();
  state.puzzles = [...report.puzzles];
  state.current = null;
  state.sessionSeen.clear();
  enterTrainer();
  showNextPuzzle();
}

$("#practiceReviewPuzzles").addEventListener("click", () => openReviewPractice().catch(error => showToast(error.message || "Those practice positions could not be opened.")));

async function buildDeck(force = false) {
  if (state.analyzing) return;
  const selectedGames = state.games.filter(game => state.selectedIds.has(game.id));
  if (!selectedGames.length) return showToast("Select at least one game.");
  const provider = engineDescriptor(state.prefs.engineProvider);
  if (!canUseEngine(provider)) {
    state.prefs.engineProvider = DEFAULT_PREFS.engineProvider;
    savePreferences();
    showToast("The free beta uses the included Stockfish and Reckless browser engines.");
    return;
  }
  state.analyzing = true;
  state.analysisCancelled = false;
  state.puzzles = [];
  state.current = null;
  state.sessionSeen.clear();
  showAnswer("thinking");
  $("#thinkingEngine").textContent = provider.name;
  $("#thinkingDetail").textContent = "Games are processed one at a time. The first qualifying puzzle will appear while the remaining games continue in the background.";
  $("#analysisBanner").classList.remove("hidden");
  $("#analysisProgress").style.width = "0%";
  $("#analysisTitle").textContent = `Preparing ${provider.name}…`;
  $("#analysisDetail").textContent = provider.detail;

  const cache = loadJson(analysisKey(), { version: ANALYSIS_VERSION, games: {} });
  if (cache.version !== ANALYSIS_VERSION) Object.assign(cache, { version: ANALYSIS_VERSION, games: {} });
  let engine = null;
  let finished = 0;
  try {
    for (const game of selectedGames) {
      $("#analysisTitle").textContent = `Loading game ${finished + 1} of ${selectedGames.length} · ${game.opponent}`;
      const detail = await getGameDetail(game.id);
      if (state.analysisCancelled) break;
      const cached = cache.games[game.id];
      const fingerprint = engineFingerprint(provider, state.prefs.analysisLevel);
      const usedCache = !force && cached?.engine === fingerprint;
      let gamePuzzles = usedCache ? cached.puzzles : null;
      if (!gamePuzzles) {
        if (!engine) {
          engine = createEngine(provider.id, { level: state.prefs.analysisLevel });
          state.analysisEngine = engine;
          const removeProgress = engine.onProgress?.(progress => {
            $("#analysisDetail").textContent = downloadProgressText(progress);
          });
          try { await engine.init(); }
          finally { removeProgress?.(); }
        }
        $("#analysisTitle").textContent = `${provider.name} · game ${finished + 1} of ${selectedGames.length} vs ${game.opponent}`;
        gamePuzzles = await analyzeGameInBrowser(engine, detail, game, (current, total) => {
          $("#analysisDetail").textContent = `Game ${finished + 1} of ${selectedGames.length} · move ${current} of ${total} · ${engineLimitText(provider)}`;
        }, async puzzle => {
          state.puzzles.push(puzzle);
          state.puzzles.sort((a, b) => (b.impact ?? b.loss) - (a.impact ?? a.loss));
          updateStats();
          if (!state.current) await showNextPuzzle();
        });
        cache.games[game.id] = { engine: fingerprint, analyzedAt: Date.now(), puzzles: gamePuzzles };
        saveJson(analysisKey(), cache);
      }
      if (usedCache) {
        state.puzzles.push(...gamePuzzles);
        state.puzzles.sort((a, b) => (b.impact ?? b.loss) - (a.impact ?? a.loss));
      }
      finished += 1;
      $("#analysisProgress").style.width = `${Math.round((finished / selectedGames.length) * 100)}%`;
      updateStats();
      if (!state.current && state.puzzles.length) await showNextPuzzle();
    }
    $("#engineName").textContent = state.analysisCancelled ? `${provider.name} · analysis stopped` : `${provider.name} · analysis ready`;
    updateStats();
    if (!state.current && state.puzzles.length) await showNextPuzzle();
    else if (!state.puzzles.length) showAnswer("empty");
  } catch (error) {
    if (state.analysisCancelled || isEngineCancellation(error)) {
      showToast("Training analysis stopped. Puzzles already found remain available.");
      return;
    }
    console.error(error);
    if (!state.current) showAnswer("welcome");
    showToast(error.message || "Browser analysis failed.");
  } finally {
    engine?.close();
    state.analysisEngine = null;
    state.analyzing = false;
    $("#analysisBanner").classList.add("hidden");
  }
}

function stopTrainingAnalysis() {
  if (!state.analyzing) return;
  state.analysisCancelled = true;
  $("#analysisTitle").textContent = "Stopping analysis…";
  $("#analysisDetail").textContent = "Completed puzzles will remain available.";
  state.analysisEngine?.close();
}

$("#stopTrainingAnalysis").addEventListener("click", stopTrainingAnalysis);

async function getGameDetail(id) {
  if (!state.details.has(id)) state.details.set(id, buildGameDetail(id));
  return state.details.get(id);
}

async function analyzeGameInBrowser(engine, detail, game, onProgress, onPuzzle) {
  const playerPlyParity = game.playerColor === "white" ? 1 : 0;
  const playerMoves = detail.moves.filter(move => move.ply % 2 === playerPlyParity);
  const puzzles = [];
  for (let index = 0; index < playerMoves.length; index += 1) {
    const move = playerMoves[index];
    const fen = detail.frames[move.ply - 1].fen;
    onProgress(index + 1, playerMoves.length);
    const best = await engine.evaluate(fen);
    if (!best.bestmove || best.bestmove === "(none)") continue;
    const playedMatchesBest = move.uci === best.bestmove || move.uci.slice(0, 4) === best.bestmove.slice(0, 4) && !best.bestmove[4];
    const bestValue = sideToMoveScore(best);
    const position = new Chess(fen);
    const bestMoveInfo = findVerboseMove(position, best.bestmove);
    const bestSan = bestMoveInfo?.san || best.bestmove;

    if (!playedMatchesBest) {
      const played = await engine.evaluate(fen, move.uci);
      const playedValue = sideToMoveScore(played);
      const eligibility = classifyPuzzleEligibility({
        bestValue,
        playedValue,
        bestMate: best.mate,
        playedMate: played.mate,
      });
      if (eligibility.eligible) {
        const puzzle = makePuzzle(game, move, fen, eligibility.category, eligibility.loss, best, bestSan, played, engine.descriptor);
        puzzles.push(puzzle);
        await onPuzzle?.(puzzle);
      }
    }

  }
  return puzzles;
}

function makePuzzle(game, move, fen, category, loss, best, bestSan, played, provider) {
  return {
    id: `${game.id}:${move.ply}:${category.toLowerCase().replaceAll(" ", "-")}`,
    gameId: game.id,
    ply: move.ply,
    moveNumber: Math.ceil(move.ply / 2),
    fen,
    category,
    loss: Math.min(loss, 100000),
    impact: Math.min(loss, 100000),
    best: best.bestmove,
    bestSan,
    bestEval: formatEval(best),
    bestPv: pvToSan(fen, best.pv),
    played: move.uci,
    playedSan: move.san,
    playedEval: formatEval(played),
    bestResult: { cp: best.cp, mate: best.mate },
    engineName: provider?.name || "Engine",
    game: { ...game },
  };
}

function formatEval(result) {
  if (result.mate !== null) return result.mate > 0 ? `Mate in ${result.mate}` : `Mated in ${Math.abs(result.mate)}`;
  const pawns = (result.cp ?? 0) / 100;
  return `${pawns >= 0 ? "+" : "−"}${Math.abs(pawns).toFixed(1)}`;
}

function findVerboseMove(chess, uci) {
  return chess.moves({ verbose: true }).find(move => move.from === uci.slice(0, 2) && move.to === uci.slice(2, 4) && (!uci[4] || move.promotion === uci[4]));
}

function pvToSan(fen, pv) {
  const chess = new Chess(fen);
  const san = [];
  for (const uci of pv.slice(0, 8)) {
    const move = findVerboseMove(chess, uci);
    if (!move) break;
    san.push(move.san);
    chess.move(move);
  }
  return san.join(" ");
}

function schedule() { return loadJson(scheduleKey(), {}); }

function updateStats() {
  const cards = schedule();
  const now = Date.now();
  $("#puzzleCount").textContent = state.puzzles.length;
  $("#dueCount").textContent = state.puzzles.filter(puzzle => !cards[puzzle.id] || cards[puzzle.id].due <= now).length;
  $("#profileReviews").textContent = Object.values(cards).reduce((sum, card) => sum + (card.reviews || 0), 0);
  $("#profileMastered").textContent = Object.values(cards).filter(card => card.interval >= 21).length;
  $("#profileStreak").textContent = state.puzzles.filter(puzzle => !cards[puzzle.id] || cards[puzzle.id].due <= now).length;
}

async function showNextPuzzle() {
  if (!state.puzzles.length) return showAnswer("empty");
  const cards = schedule();
  const now = Date.now();
  let candidates = state.puzzles
    .filter(puzzle => !state.sessionSeen.has(puzzle.id))
    .sort((a, b) => (cards[a.id]?.due || 0) - (cards[b.id]?.due || 0));
  if (!candidates.length) {
    state.sessionSeen.clear();
    candidates = [...state.puzzles].sort((a, b) => (cards[a.id]?.due || 0) - (cards[b.id]?.due || 0));
  }
  const due = candidates.filter(puzzle => !cards[puzzle.id] || cards[puzzle.id].due <= now);
  state.current = due[0] || candidates[0];
  state.sessionSeen.add(state.current.id);
  await loadPuzzle(state.current);
}

async function loadPuzzle(puzzle) {
  state.phase = "puzzle";
  state.selectedSquare = null;
  state.legalMoves = [];
  state.puzzleChess = new Chess(puzzle.fen);
  $("#puzzleEvalBar").classList.add("hidden");
  renderEvaluationBar($("#puzzleEvalBar"), null, puzzle.fen, puzzle.game.playerColor === "black");
  clearArrows();
  renderBoard();
  showAnswer("puzzle");
  setBoardMessage("Select a piece, then choose its destination.");
  const category = $("#puzzleCategory");
  category.textContent = "Your move";
  category.className = "category";
  $("#puzzlePrompt").textContent = "Find the best move in this position";
  $("#puzzleOpponent").textContent = `vs ${puzzle.game.opponent}`;
  $("#puzzleMeta").textContent = `${puzzle.game.date} · ${puzzle.game.timeClass} · move ${puzzle.moveNumber}`;
  $("#puzzleHint").textContent = puzzle.positionalTagline || "Look for checks, captures, and forcing threats.";
  const detail = await getGameDetail(puzzle.gameId);
  renderNotation(detail, puzzle, false);
}

function parseFen(fen) {
  const map = new Map();
  fen.split(" ")[0].split("/").forEach((row, rowIndex) => {
    let file = 0;
    for (const char of row) {
      if (/\d/.test(char)) file += Number(char);
      else {
        map.set(`${String.fromCharCode(97 + file)}${8 - rowIndex}`, char);
        file += 1;
      }
    }
  });
  return map;
}

function renderBoard(lastMove = null) {
  const fen = state.puzzleChess?.fen() || "8/8/8/8/8/8/8/8 w - - 0 1";
  const pieces = parseFen(fen);
  const flipped = state.current?.game.playerColor === "black";
  const files = flipped ? ["h","g","f","e","d","c","b","a"] : ["a","b","c","d","e","f","g","h"];
  const ranks = flipped ? [1,2,3,4,5,6,7,8] : [8,7,6,5,4,3,2,1];
  const legalTargets = new Map(state.legalMoves.map(move => [move.to, move]));
  const lastSquares = lastMove ? [lastMove.slice(0,2), lastMove.slice(2,4)] : [];
  const html = [];
  ranks.forEach((rank, row) => files.forEach((file, column) => {
    const square = `${file}${rank}`;
    const piece = pieces.get(square);
    const fileIndex = file.charCodeAt(0) - 97;
    const dark = (fileIndex + rank) % 2 === 1;
    const legal = legalTargets.get(square);
    const pieceName = piece ? `${piece === piece.toUpperCase() ? "w" : "b"}${piece.toUpperCase()}` : null;
    html.push(`<button class="square ${dark ? "dark" : ""} ${state.selectedSquare === square ? "selected" : ""} ${legal ? `legal ${legal.captured ? "capture" : ""}` : ""} ${lastSquares.includes(square) ? "last" : ""}" data-square="${square}" aria-label="${square}">
      ${column === 0 ? `<span class="coord rank">${rank}</span>` : ""}${row === 7 ? `<span class="coord file">${file}</span>` : ""}
      ${pieceName ? `<img class="piece-image" draggable="false" src="${assetUrl(`./pieces/${state.prefs.pieces}/${pieceName}.svg`)}" alt="">` : ""}
    </button>`);
  }));
  $("#board").innerHTML = html.join("");
  $$("#board .square").forEach(square => square.addEventListener("click", () => handleSquare(square.dataset.square)));
  $$("#board .piece-image").forEach(piece => piece.addEventListener("pointerdown", startPointerDrag));
}

function handleSquare(square) {
  if (state.suppressClick || state.phase !== "puzzle" || !state.puzzleChess) return;
  const clickedPiece = state.puzzleChess.get(square);
  if (!state.selectedSquare) {
    if (!clickedPiece || clickedPiece.color !== state.puzzleChess.turn()) return;
    selectSquare(square);
    return;
  }
  if (square === state.selectedSquare) {
    state.selectedSquare = null;
    state.legalMoves = [];
    return renderBoard();
  }
  const candidate = state.legalMoves.find(move => move.to === square);
  if (candidate) {
    attemptMove(state.selectedSquare, square);
    return;
  }
  if (clickedPiece?.color === state.puzzleChess.turn()) selectSquare(square);
}

function attemptMove(from, to) {
  if (state.phase !== "puzzle" || !state.puzzleChess) return false;
  const moves = state.puzzleChess.moves({ square: from, verbose: true });
  const candidate = moves.find(move => move.to === to);
  if (!candidate) return false;
  const move = state.puzzleChess.move({ from, to, promotion: candidate.promotion || "q" });
  state.selectedSquare = null;
  state.legalMoves = [];
  clearArrows();
  renderBoard(`${move.from}${move.to}`);
  checkAttempt(move);
  return true;
}

function selectSquare(square) {
  state.selectedSquare = square;
  state.legalMoves = state.puzzleChess.moves({ square, verbose: true });
  renderBoard();
}

function startPointerDrag(event) {
  if (state.phase !== "puzzle" || !state.puzzleChess || event.button > 0 || event.shiftKey) return;
  const squareElement = event.currentTarget.closest(".square");
  const square = squareElement?.dataset.square;
  const piece = square && state.puzzleChess.get(square);
  if (!piece || piece.color !== state.puzzleChess.turn()) return;
  state.pointerDrag = {
    from: square,
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    source: event.currentTarget,
    dragging: false,
    ghost: null,
  };
}

function movePointerDrag(event) {
  const drag = state.pointerDrag;
  if (!drag) return;
  drag.x = event.clientX;
  drag.y = event.clientY;
  if (!drag.dragging && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 6) {
    drag.dragging = true;
    state.selectedSquare = drag.from;
    state.legalMoves = state.puzzleChess.moves({ square: drag.from, verbose: true });
    drag.source.classList.add("dragging");
    drag.ghost = drag.source.cloneNode(true);
    drag.ghost.className = "drag-ghost";
    const size = drag.source.getBoundingClientRect().width;
    drag.ghost.style.width = `${size}px`;
    drag.ghost.style.height = `${size}px`;
    document.body.appendChild(drag.ghost);
    for (const move of state.legalMoves) {
      const target = document.querySelector(`[data-square="${move.to}"]`);
      target?.classList.add("legal");
      if (move.captured) target?.classList.add("capture");
    }
    document.querySelector(`[data-square="${drag.from}"]`)?.classList.add("selected");
  }
  if (drag.dragging) {
    event.preventDefault();
    drag.ghost.style.left = `${drag.x}px`;
    drag.ghost.style.top = `${drag.y}px`;
    $$("#board .drag-over").forEach(square => square.classList.remove("drag-over"));
    const target = document.elementFromPoint(drag.x, drag.y)?.closest(".square");
    if (target && state.legalMoves.some(move => move.to === target.dataset.square)) target.classList.add("drag-over");
  }
}

function endPointerDrag(event) {
  const drag = state.pointerDrag;
  if (!drag) return;
  state.pointerDrag = null;
  if (!drag.dragging) return;
  event.preventDefault();
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".square");
  drag.ghost?.remove();
  drag.source?.classList.remove("dragging");
  state.suppressClick = true;
  const moved = target && attemptMove(drag.from, target.dataset.square);
  if (!moved) {
    state.selectedSquare = null;
    state.legalMoves = [];
    renderBoard();
  }
  setTimeout(() => { state.suppressClick = false; }, 80);
}

document.addEventListener("pointermove", movePointerDrag, { passive: false });
document.addEventListener("pointerup", endPointerDrag, { passive: false });
document.addEventListener("pointercancel", endPointerDrag, { passive: false });

function checkAttempt(move) {
  const attempted = `${move.from}${move.to}${move.promotion || ""}`;
  const target = state.current.best;
  const correct = attempted === target || attempted.slice(0,4) === target.slice(0,4) && !target[4];
  if (correct) {
    playSound("correct");
    revealSolution(true);
  }
  else {
    playSound("wrong");
    state.phase = "wrong";
    setBoardMessage("Wrong move. Try the position again or reveal the solution.", "wrong");
    $("#wrongText").textContent = `${move.san} is legal, but it misses ${engineDescriptor(state.prefs.engineProvider).name}'s stronger move.`;
    $("#attemptMove").textContent = move.san;
    $("#attemptEval").textContent = `${engineDescriptor(state.prefs.engineProvider).name} is evaluating…`;
    showAnswer("wrong");
    evaluateWrongMove(attempted, move.san);
  }
}

async function getPracticeEngine() {
  if (state.practiceEngine) return state.practiceEngine;
  if (!state.practiceEnginePromise) {
    state.practiceEnginePromise = (async () => {
      const engine = createEngine(state.prefs.engineProvider, { level: state.prefs.analysisLevel });
      await engine.init();
      state.practiceEngine = engine;
      return engine;
    })().catch(error => {
      state.practiceEnginePromise = null;
      throw error;
    });
  }
  return state.practiceEnginePromise;
}

function evaluateWrongMove(uci, san) {
  const puzzleId = state.current.id;
  const fen = state.current.fen;
  const token = ++state.wrongEvalToken;
  state.practiceQueue = state.practiceQueue.then(async () => {
    const engine = await getPracticeEngine();
    const result = await engine.evaluate(fen, uci);
    if (token === state.wrongEvalToken && state.current?.id === puzzleId && state.phase === "wrong") {
      $("#attemptMove").textContent = san;
      $("#attemptEval").textContent = `${engineDescriptor(state.prefs.engineProvider).name} ${formatEval(result)}`;
    }
  }).catch(error => {
    console.error(error);
    if (token === state.wrongEvalToken && state.phase === "wrong") $("#attemptEval").textContent = "Evaluation unavailable";
  });
}

$("#tryAgainButton").addEventListener("click", () => loadPuzzle(state.current));
$("#showSolutionButton").addEventListener("click", () => { playSound("reveal"); revealSolution(false); });

function revealSolution(correct) {
  state.phase = "solution";
  state.puzzleChess = new Chess(state.current.fen);
  const bestInfo = findVerboseMove(state.puzzleChess, state.current.best);
  if (bestInfo) state.puzzleChess.move(bestInfo);
  renderBoard(state.current.best);
  $("#puzzleEvalBar").classList.remove("hidden");
  renderEvaluationBar($("#puzzleEvalBar"), state.current.bestResult, state.current.fen, state.current.game.playerColor === "black");
  clearArrows();
  drawArrow(state.current.best, "#2d7a55");
  setBoardMessage(correct ? "Correct. Review the engine line, then grade the position." : "Solution shown. Review it, then grade the position.", "correct");
  $("#solutionIcon").textContent = correct ? "✓" : "→";
  const categoryClass = state.current.category.toLowerCase().replaceAll(" ", "-");
  $("#puzzleCategory").textContent = state.current.category;
  $("#puzzleCategory").className = `category ${categoryClass}`;
  $("#solutionKicker").textContent = `${correct ? "Correct" : "Solution"} · ${state.current.category}`;
  $("#solutionTitle").textContent = state.current.positionalTagline || (correct ? "That is the move." : "This was the stronger move.");
  $("#playedLabel").textContent = "Played in the game";
  $("#bestLabel").textContent = "Best move";
  $("#playedMove").textContent = state.current.playedSan;
  const providerName = state.current.engineName || engineDescriptor(state.prefs.engineProvider).name;
  $("#playedEval").textContent = `${providerName} ${state.current.playedEval}`;
  $("#bestMove").textContent = state.current.bestSan;
  $("#bestEval").textContent = `${providerName} ${state.current.bestEval}`;
  $("#solutionEngineLabel").textContent = `${providerName} continuation`;
  $("#solutionLine").textContent = state.current.bestPv || state.current.bestSan;
  showAnswer("solution");
  renderNotation(state.details.get(state.current.gameId), state.current, true);
}

function clearArrows() { trainingArrowLayer?.clear(); }

function drawArrow(uci, color) { trainingArrowLayer?.setSystemArrow(uci, color); }

function setBoardMessage(text, type = "") {
  $("#boardMessageText").textContent = text;
  $("#boardMessage").className = `board-message ${type}`;
}

function showAnswer(name) {
  for (const panel of ["welcome", "thinking", "puzzle", "wrong", "solution", "empty"]) {
    $(`#${panel}Panel`).classList.toggle("hidden", panel !== name);
  }
}

function renderNotation(detail, puzzle, revealed) {
  if (!detail) return;
  const moves = detail.moves;
  const rows = [];
  for (let index = 0; index < moves.length; index += 2) {
    const white = notationCell(moves[index], puzzle, revealed);
    const black = notationCell(moves[index + 1], puzzle, revealed);
    rows.push(`<div class="notation-row"><span>${Math.floor(index / 2) + 1}.</span>${white}${black}</div>`);
  }
  $("#notationList").innerHTML = rows.join("");
  const studiedName = state.displayName || state.username;
  $("#notationGame").textContent = `${puzzle.game.playerColor === "white" ? studiedName : puzzle.game.opponent} – ${puzzle.game.playerColor === "black" ? studiedName : puzzle.game.opponent}`;
  $("#notationResult").textContent = puzzle.game.result;
  $("#notationOpening").textContent = puzzle.game.opening;
  const sourceLink = $("#chessComLink");
  sourceLink.classList.toggle("hidden", !detail.url);
  if (detail.url) sourceLink.href = detail.url;
  requestAnimationFrame(() => $("#notationList .current")?.scrollIntoView({ block: "center" }));
}

function notationCell(move, puzzle, revealed) {
  if (!move) return `<span class="notation-move"></span>`;
  if (move.ply === puzzle.ply) return `<span class="notation-move current">${revealed ? escapeHtml(move.san) : "?"}</span>`;
  if (move.ply > puzzle.ply && !revealed) return `<span class="notation-move">·</span>`;
  return `<span class="notation-move ${move.ply < puzzle.ply ? "past" : ""}">${escapeHtml(move.san)}</span>`;
}

$$('[data-rating]').forEach(button => button.addEventListener("click", () => ratePuzzle(button.dataset.rating)));

function ratePuzzle(rating) {
  const cards = schedule();
  const old = cards[state.current.id] || { interval: 0, ease: 2.5, reviews: 0, lapses: 0 };
  const next = { ...old, reviews: old.reviews + 1 };
  if (rating === "again") {
    next.interval = 0;
    next.due = Date.now() + 10 * 60 * 1000;
    next.lapses += 1;
    state.sessionSeen.delete(state.current.id);
  } else if (rating === "hard") {
    next.interval = Math.max(1, Math.round((old.interval || 1) * 1.2));
    next.ease = Math.max(1.3, old.ease - .15);
    next.due = Date.now() + next.interval * DAY;
  } else if (rating === "easy") {
    next.interval = old.interval ? Math.max(7, Math.round(old.interval * old.ease * 1.3)) : 7;
    next.ease = old.ease + .1;
    next.due = Date.now() + next.interval * DAY;
  } else {
    next.interval = old.interval ? Math.max(3, Math.round(old.interval * old.ease)) : 3;
    next.due = Date.now() + next.interval * DAY;
  }
  cards[state.current.id] = next;
  saveJson(scheduleKey(), cards);
  updateStats();
  showNextPuzzle();
}

function renderGamePicker() {
  $("#gamePicker").innerHTML = state.games.map(game => `<label class="pick-game">
    <input type="checkbox" value="${game.id}" ${state.selectedIds.has(game.id) ? "checked" : ""}>
    <span><strong>${escapeHtml(game.opponent)}</strong><span>${escapeHtml(game.date)} · ${escapeHtml(game.timeClass)} · ${escapeHtml(game.opening)}</span></span>
    <span class="pick-result ${game.result.toLowerCase()}">${game.result}</span>
  </label>`).join("");
  $("#gamePicker").querySelectorAll("input").forEach(input => input.addEventListener("change", updateSelectedGameLabel));
  updateSelectedGameLabel();
}

function updateSelectedGameLabel() {
  $("#selectedGameCount").textContent = `${$("#gamePicker").querySelectorAll("input:checked").length} selected`;
}

$("#gamesButton").addEventListener("click", () => {
  renderGamePicker();
  $("#gamesDialog").showModal();
});

$("#selectAllGames").addEventListener("click", () => {
  const inputs = [...$("#gamePicker").querySelectorAll("input")];
  const shouldSelect = inputs.some(input => !input.checked);
  inputs.forEach(input => input.checked = shouldSelect);
  updateSelectedGameLabel();
});

$("#applyGamesButton").addEventListener("click", () => {
  state.selectedIds = new Set([...$("#gamePicker").querySelectorAll("input:checked")].map(input => input.value));
  if (!state.selectedIds.size) return showToast("Select at least one game.");
  $("#gamesDialog").close();
  buildDeck();
});

$("#startAnalysisButton").addEventListener("click", () => buildDeck(true));

function applyPreferences() {
  const themePreference = state.prefs.siteTheme || "system";
  document.body.dataset.siteTheme = resolveSiteTheme(themePreference, systemColorScheme?.matches);
  document.body.dataset.siteThemePreference = themePreference;
  $("#boardShell").className = `board-shell theme-${state.prefs.theme}`;
  $("#analysisBoardShell").className = `board-shell analysis-board-shell theme-${state.prefs.theme}`;
  document.body.classList.toggle("reduce-effects", !state.prefs.effectsEnabled);
  $("#effectsToggle").checked = state.prefs.effectsEnabled !== false;
  $("#masterVolume").value = Math.round((state.prefs.masterVolume ?? .65) * 100);
  $("#volumeOutput").textContent = `${$("#masterVolume").value}%`;
  $$('button[data-site-theme]').forEach(button => {
    button.classList.toggle("active", button.dataset.siteTheme === themePreference);
    button.disabled = false;
    button.title = "";
  });
  $$('[data-theme]').forEach(button => button.classList.toggle("active", button.dataset.theme === state.prefs.theme));
  $$('[data-pieces]').forEach(button => button.classList.toggle("active", button.dataset.pieces === state.prefs.pieces));
  $$('[data-engine-provider]').forEach(button => button.classList.toggle("active", button.dataset.engineProvider === state.prefs.engineProvider));
  $$('[data-analysis-level]').forEach(button => button.classList.toggle("active", button.dataset.analysisLevel === state.prefs.analysisLevel));
  $$('[data-report-game-limit]').forEach(button => button.classList.toggle("active", Number(button.dataset.reportGameLimit) === state.prefs.reportGameLimit));
  if ($("#reviewGameLimit")) $("#reviewGameLimit").value = String(state.prefs.reportGameLimit);
  const level = analysisLimits(state.prefs.analysisLevel);
  $("#analysisLevelNote").textContent = `${level.label}: Stockfish depth ${level.stockfishDepth} · Reckless ${level.recklessNodes.toLocaleString()} nodes. ${level.detail}`;
  $("#reportGameLimitNote").textContent = `${state.prefs.reportGameLimit} games per Chess Report or Tactics Report. Training still includes every game from the last 7 days when that is larger.`;
  const provider = engineDescriptor(state.prefs.engineProvider);
  if (!state.analyzing) $("#engineName").textContent = `${provider.name} runs fully in your browser`;
  if (state.puzzleChess) renderBoard();
  generalAnalysisBoard?.refresh();
  enginePlay?.refresh();
}

function renderEngineChoices() {
  $("#engineChoices").innerHTML = engineDescriptors().filter(provider => provider.local).map(provider => {
    const badge = provider.releaseStage === "alpha" ? "Full local · Alpha" : "Full local";
    return `<button type="button" data-engine-provider="${provider.id}">
    <span><strong>${escapeHtml(provider.selectorName || provider.name)}</strong><small>${escapeHtml(provider.detail || "Remote analysis")}</small>${provider.caution ? `<small>${escapeHtml(provider.caution)}</small>` : ""}</span>
    <em>${badge}</em>
  </button>`;
  }).join("");
  $$('[data-engine-provider]').forEach(button => button.addEventListener("click", () => {
    if (button.disabled || button.dataset.engineProvider === state.prefs.engineProvider) return;
    if (state.analyzing) return showToast("Finish the current deck analysis before changing engines.");
    const provider = engineDescriptor(button.dataset.engineProvider);
    state.practiceEngine?.close();
    state.practiceEngine = null;
    state.practiceEnginePromise = null;
    generalAnalysisBoard?.cancel();
    state.prefs.engineProvider = button.dataset.engineProvider;
    savePreferences();
    const selected = engineDescriptor(state.prefs.engineProvider);
    showToast(selected.id === "reckless-browser"
      ? "Reckless alpha selected. Starting analysis may download about 61.5 MiB to this browser."
      : `${selected.name} selected for new analysis.`);
  }));
  applyPreferences();
}

$("#settingsButton").addEventListener("click", () => {
  applyPreferences();
  updateIdentityUI();
  $("#settingsDialog").showModal();
});

$$('[data-theme]').forEach(button => button.addEventListener("click", () => {
  state.prefs.theme = button.dataset.theme;
  saveJson(prefsKey(), state.prefs);
  applyPreferences();
}));

$$('button[data-site-theme]').forEach(button => button.addEventListener("click", () => {
  state.prefs.siteTheme = button.dataset.siteTheme;
  saveJson(prefsKey(), state.prefs);
  applyPreferences();
}));

$$('[data-analysis-level]').forEach(button => button.addEventListener("click", () => {
  const level = normalizeAnalysisLevel(button.dataset.analysisLevel);
  if (level === state.prefs.analysisLevel) return;
  if (state.analyzing || state.reportAbortController) return showToast("Stop the current analysis before changing strength.");
  state.practiceEngine?.close();
  state.practiceEngine = null;
  state.practiceEnginePromise = null;
  generalAnalysisBoard?.cancel();
  enginePlay?.resetEngine?.();
  state.prefs.analysisLevel = level;
  savePreferences();
  showToast(`${ANALYSIS_LEVELS[level].label} analysis selected. Stronger levels take longer.`);
}));

$$('[data-report-game-limit]').forEach(button => button.addEventListener("click", () => {
  const gameLimit = normalizeReportGameLimit(button.dataset.reportGameLimit);
  if (gameLimit === state.prefs.reportGameLimit) return;
  if (state.reportAbortController) return showToast("Stop the current report before changing its game count.");
  state.prefs.reportGameLimit = gameLimit;
  savePreferences();
  updateGameSourceUI();
  updateReportSourceUI("wrapped");
  updateReportSourceUI("tactics");
  showToast(`${gameLimit} games selected for new reports. Larger reports take longer.`);
}));

$("#reviewGameLimit").addEventListener("change", event => {
  if (state.reportAbortController) {
    event.currentTarget.value = String(state.prefs.reportGameLimit);
    return showToast("Stop the current review before changing its game count.");
  }
  state.prefs.reportGameLimit = normalizeReportGameLimit(event.currentTarget.value);
  savePreferences();
  applyPreferences();
  updateReportSourceUI("tactics");
});

$$('[data-pieces]').forEach(button => button.addEventListener("click", () => {
  state.prefs.pieces = button.dataset.pieces;
  saveJson(prefsKey(), state.prefs);
  applyPreferences();
}));

$("#profileButton").addEventListener("click", () => {
  const name = state.appUser?.username || "Guest";
  $("#profileDialogName").textContent = name;
  updateStats();
  $("#profileDialog").showModal();
});

function enterGuestSession() {
  state.appUser = null;
  state.guest = true;
  continueAsGuest();
  loadAccountPreferences();
  renderEngineChoices();
  updateIdentityUI();
}

async function leaveCurrentSession() {
  if (state.appUser?.storage === "cloud") await signOutCloud().catch(error => showToast(error.message));
  clearProfileSession();
  enterGuestSession();
  if ($("#settingsDialog").open) $("#settingsDialog").close();
  if ($("#profileDialog").open) $("#profileDialog").close();
  goHome();
  renderProfileChoices();
  if (!$("#authDialog").open) $("#authDialog").showModal();
}

$("#changeAccountButton").addEventListener("click", leaveCurrentSession);

function savePreferences() {
  saveJson(prefsKey(), state.prefs);
  applyPreferences();
}

$("#effectsToggle").addEventListener("change", event => {
  state.prefs.effectsEnabled = event.currentTarget.checked;
  savePreferences();
  if (state.prefs.effectsEnabled) playSound("move");
});

$("#masterVolume").addEventListener("input", event => {
  state.prefs.masterVolume = Number(event.currentTarget.value) / 100;
  $("#volumeOutput").textContent = `${event.currentTarget.value}%`;
  saveJson(prefsKey(), state.prefs);
});

$("#masterVolume").addEventListener("change", () => playSound("move"));
$("#testSoundButton").addEventListener("click", () => playSound("correct"));

function playSound(kind) {
  if (!state.prefs.effectsEnabled || (state.prefs.masterVolume ?? .65) <= 0) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  const context = state.audioContext || (state.audioContext = new AudioContextClass());
  if (context.state === "suspended") context.resume();
  const volume = Math.min(.18, (state.prefs.masterVolume ?? .65) * .18);
  const notes = kind === "correct" ? [[523, 0, .06], [659, .07, .09]]
    : kind === "wrong" ? [[190, 0, .13]]
    : kind === "reveal" ? [[330, 0, .08]] : [[440, 0, .045]];
  for (const [frequency, delay, duration] of notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = kind === "wrong" ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(frequency, context.currentTime + delay);
    gain.gain.setValueAtTime(0.0001, context.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(volume, context.currentTime + delay + .008);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + delay + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(context.currentTime + delay);
    oscillator.stop(context.currentTime + delay + duration + .01);
  }
}

$$('[data-settings-tab]').forEach(button => button.addEventListener("click", () => {
  $$('[data-settings-tab]').forEach(tab => tab.classList.toggle("active", tab === button));
  $$('[data-settings-pane]').forEach(pane => pane.classList.toggle("hidden", pane.dataset.settingsPane !== button.dataset.settingsTab));
}));

function renderProfileChoices() {
  const profiles = listDeviceProfiles();
  $("#savedProfiles").classList.toggle("hidden", !profiles.length);
  $("#profileChoices").innerHTML = profiles.map(profile => `<button type="button" data-profile-id="${escapeHtml(profile.id)}"><span>${escapeHtml(profile.username)}</span><small>Device profile</small></button>`).join("");
  $$('[data-profile-id]').forEach(button => button.addEventListener("click", () => {
    try {
      signOutCloud().catch(console.error);
      state.appUser = activateDeviceProfile(button.dataset.profileId);
      state.guest = false;
      loadAccountPreferences();
      renderEngineChoices();
      updateIdentityUI();
      $("#authDialog").close();
    } catch (error) {
      $("#authError").textContent = error.message;
    }
  }));
}

$("#guestButton").addEventListener("click", () => {
  signOutCloud().catch(console.error);
  enterGuestSession();
  $("#authDialog").close();
});

$("#logoutButton").addEventListener("click", leaveCurrentSession);

function loadAccountPreferences() {
  state.prefs = { ...DEFAULT_PREFS, ...loadJson(prefsKey(), {}) };
  state.prefs.analysisLevel = normalizeAnalysisLevel(state.prefs.analysisLevel);
  state.prefs.reportGameLimit = normalizeReportGameLimit(state.prefs.reportGameLimit);
  if (!canUseEngine(engineDescriptor(state.prefs.engineProvider))) state.prefs.engineProvider = DEFAULT_PREFS.engineProvider;
  applyPreferences();
}

function updateIdentityUI() {
  const name = state.appUser?.username || "Guest";
  $("#profileName").textContent = name;
  $("#profileDialogName").textContent = name;
  $("#settingsAccountName").textContent = name;
  const cloud = state.appUser?.storage === "cloud";
  $("#settingsAccountDetail").textContent = cloud ? `${state.appUser.email || "Cloud account"} · remembered on this device.` : state.appUser ? "This device profile keeps progress and preferences separate in this browser." : "Guest progress is saved only in this browser.";
  $("#settingsPlanDetail").textContent = "Free beta: Stockfish, Reckless browser alpha, reports, master games, analysis, and review tools are included.";
  $("#profileDialogName").textContent = name;
  $("#accountSyncNote").textContent = cloud ? "Larger imported game libraries, reports, preferences, and puzzle review status sync through your DoBackChess cloud account." : "Sign in to retain a larger imported game library and sync reports, preferences, and puzzle review status.";
  $("#logoutButton").textContent = state.appUser ? (cloud ? "Sign out" : "Switch profile") : "Sign in or switch account";
  $$("[data-link-provider]").forEach(button => {
    const providerId = `${button.dataset.linkProvider}.com`;
    button.classList.toggle("hidden", !cloud || state.appUser.providers?.includes(providerId));
  });
}

function captureLocalMigration() {
  const identity = identityKey();
  const source = state.source;
  const username = state.username;
  return {
    prefs: { ...state.prefs },
    library: username ? loadJson(`replay:library:${identity}:${source}:${username.toLowerCase()}`, null) : null,
    schedule: username ? loadJson(`replay:schedule:${identity}:${source}:${username.toLowerCase()}`, null) : null,
    playedGames: loadJson(`replay:played-games:${identity}`, null),
  };
}

async function activateCloudUser(user, migration = null) {
  if (!user) return;
  const previousPrefs = migration?.prefs || { ...state.prefs };
  lastCloudUserId = user.id;
  state.appUser = user;
  state.guest = false;
  clearProfileSession();
  const key = prefsKey();
  const cloudPrefs = await loadCloudJson(key, null);
  if (cloudPrefs) localStorage.setItem(key, JSON.stringify(cloudPrefs));
  else saveJson(key, previousPrefs);
  if (migration?.playedGames?.length) {
    const cloudGames = await loadCloudJson(playedGamesKey(), null);
    if (!cloudGames) saveJson(playedGamesKey(), migration.playedGames);
  }
  if (state.username) {
    const cloudLibrary = await loadCloudJson(libraryKey(), null);
    if (!cloudLibrary && migration?.library) saveJson(libraryKey(), migration.library);
    const cloudSchedule = await loadCloudJson(scheduleKey(), null);
    if (cloudSchedule) localStorage.setItem(scheduleKey(), JSON.stringify(cloudSchedule));
    else if (migration?.schedule) saveJson(scheduleKey(), migration.schedule);
  }
  loadAccountPreferences();
  updateIdentityUI();
  if ($("#authDialog").open) $("#authDialog").close();
  if ($("#emailAuthDialog").open) $("#emailAuthDialog").close();
}

async function handleCloudProvider(provider, button) {
  button.disabled = true;
  $("#authError").textContent = "";
  try {
    const migration = captureLocalMigration();
    const user = await signInOrLink(provider);
    if (!user) {
      $("#cloudAuthNote").textContent = "Complete sign-in on the provider page; DoBackChess will restore this account when you return.";
      return;
    }
    await activateCloudUser(user, migration);
    showToast("Google is connected to your DoBackChess account.");
  } catch (error) {
    $("#authError").textContent = error.message;
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

let emailAuthMode = "signin";

function openEmailAuth(mode) {
  emailAuthMode = mode;
  const creating = mode === "create";
  $("#emailAuthTitle").textContent = creating ? "Create your account" : "Sign in with email";
  $("#emailAuthDescription").textContent = creating
    ? "Create one account to sync your game library, reports, settings, and training progress."
    : "Use the email and password connected to your DoBackChess account.";
  $("#emailSubmitButton").textContent = creating ? "Create account" : "Sign in";
  $("#emailResetButton").classList.toggle("hidden", creating);
  $("#authPasswordConfirmLabel").classList.toggle("hidden", !creating);
  $("#authPasswordConfirm").required = creating;
  $("#authPassword").autocomplete = creating ? "new-password" : "current-password";
  $("#emailAuthError").textContent = "";
  if ($("#authDialog").open) $("#authDialog").close();
  if (!$("#emailAuthDialog").open) $("#emailAuthDialog").showModal();
  $("#authEmail").focus();
}

function setEmailAuthBusy(busy) {
  ["#emailSubmitButton", "#emailResetButton"].forEach(selector => {
    $(selector).disabled = busy;
  });
}

async function handleEmailAuth(mode) {
  const form = $("#emailAuthForm");
  if (!form.reportValidity()) return;
  if (mode === "create" && $("#authPassword").value !== $("#authPasswordConfirm").value) {
    $("#emailAuthError").textContent = "The passwords do not match.";
    $("#authPasswordConfirm").focus();
    return;
  }
  setEmailAuthBusy(true);
  $("#emailAuthError").textContent = "";
  try {
    const migration = captureLocalMigration();
    const email = $("#authEmail").value;
    const password = $("#authPassword").value;
    const user = mode === "create"
      ? await createEmailAccount(email, password)
      : await signInWithEmail(email, password);
    await activateCloudUser(user, migration);
    form.reset();
    showToast(mode === "create" ? "Your DoBackChess account is ready." : "Signed in to your DoBackChess account.");
  } catch (error) {
    $("#emailAuthError").textContent = error.message;
    showToast(error.message);
  } finally {
    setEmailAuthBusy(false);
  }
}

$("#emailAuthForm").addEventListener("submit", event => {
  event.preventDefault();
  handleEmailAuth(emailAuthMode);
});
$("#emailSignInChoice").addEventListener("click", () => openEmailAuth("signin"));
$("#emailCreateChoice").addEventListener("click", () => openEmailAuth("create"));
$("#emailAuthBackButton").addEventListener("click", () => {
  $("#emailAuthDialog").close();
  if (!$("#authDialog").open) $("#authDialog").showModal();
});
$("#emailResetButton").addEventListener("click", async () => {
  const emailInput = $("#authEmail");
  if (!emailInput.reportValidity()) return;
  setEmailAuthBusy(true);
  $("#emailAuthError").textContent = "";
  try {
    await sendEmailPasswordReset(emailInput.value);
    showToast("Password reset email sent. Check your inbox.");
  } catch (error) {
    $("#emailAuthError").textContent = error.message;
    showToast(error.message);
  } finally {
    setEmailAuthBusy(false);
  }
});

$$("[data-cloud-provider]").forEach(button => button.addEventListener("click", () => handleCloudProvider(button.dataset.cloudProvider, button)));
$$("[data-link-provider]").forEach(button => button.addEventListener("click", () => handleCloudProvider(button.dataset.linkProvider, button)));

function masterCard(player, directory = false) {
  return `<article class="master-card ${directory ? "directory-card" : ""}">
    <div><h3>${escapeHtml(player.name || player.username)}</h3><p>chess.com/member/${escapeHtml(player.username)} · 100-game master deck</p></div>
    <div class="study-actions">
      <button type="button" data-master="${escapeHtml(player.username)}" data-master-name="${escapeHtml(player.name || player.username)}"><span>Learn from mistakes</span></button>
    </div>
  </article>`;
}

function bindMasterActions(container) {
  container.querySelectorAll("[data-master]").forEach(button => button.addEventListener("click", () => {
    startStudy(button.dataset.master, "chesscom", "latest100", button.dataset.masterName, button);
  }));
}

function renderFeaturedMasters() {
  const container = $("#featuredMasters");
  container.innerHTML = FEATURED_MASTERS.map(player => masterCard(player)).join("");
  bindMasterActions(container);
}

function renderGrandmasterDirectory(query = "") {
  const normalized = query.trim().toLowerCase();
  const matching = state.grandmasters.filter(username => username.toLowerCase().includes(normalized));
  const shown = matching.slice(0, 80);
  $("#gmDirectoryStatus").textContent = `Showing ${shown.length.toLocaleString()} of ${matching.length.toLocaleString()} matching grandmasters · ${state.grandmasters.length.toLocaleString()} verified total`;
  $("#gmDirectory").innerHTML = shown.map(username => masterCard({ username, name: username }, true)).join("");
  bindMasterActions($("#gmDirectory"));
}

async function loadGrandmasterDirectory() {
  if (state.grandmasters.length) return renderGrandmasterDirectory($("#gmSearch").value);
  if (!grandmastersLoading) grandmastersLoading = fetchGrandmasterHandles();
  try {
    state.grandmasters = await grandmastersLoading;
    renderGrandmasterDirectory($("#gmSearch").value);
  } catch (error) {
    $("#gmDirectoryStatus").textContent = error.message;
  } finally {
    grandmastersLoading = null;
  }
}

function updateGameSourceUI() {
  const source = $("#gameSource").value;
  const isPgn = source === "pgn";
  $(".username-field").classList.toggle("hidden", isPgn);
  $("#username").required = !isPgn;
  $("#sourcePrefix").textContent = source === "lichess" ? "lichess.org/@/" : "chess.com/";
  $("#importForm button span").textContent = isPgn ? "Upload games" : "Build deck";
  $("#searchScopeText").textContent = isPgn ? "Upload a .pgn/.txt file or paste tournament move notation" : `Every game from the last 7 days or the latest ${state.prefs.reportGameLimit}, whichever is larger`;
  $("#heroError").textContent = "";
}

function updateReportSourceUI(mode = "wrapped") {
  const ui = reportSurface(mode);
  const isPgn = $(ui.source).value === "pgn";
  $(ui.username).classList.toggle("hidden", isPgn);
  $(ui.username).required = !isPgn;
  $(`${ui.form} button`).textContent = isPgn ? "Upload games" : mode === "tactics" ? "Review games" : "Build Chess Report";
  const scope = mode === "tactics"
    ? `Your latest ${state.prefs.reportGameLimit} selected games, with the import filled from the last 7 days first`
    : `Your latest ${state.prefs.reportGameLimit} public games, or every available game when fewer exist`;
  $(ui.scope).textContent = isPgn ? "Upload a .pgn/.txt file or paste tournament move notation" : scope;
  $(ui.error).textContent = "";
}

$("#gameSource").addEventListener("change", updateGameSourceUI);
$("#reportSource").addEventListener("change", () => updateReportSourceUI("wrapped"));
$("#tacticsReportSource").addEventListener("change", () => updateReportSourceUI("tactics"));

$("#brandHome").addEventListener("click", event => { event.preventDefault(); showAnalysis(); });
$("#navAnalysis").addEventListener("click", showAnalysis);
$("#navPlay").addEventListener("click", showPlay);
$("#navReview").addEventListener("click", showTacticsReport);
$("#gmSearch").addEventListener("input", event => renderGrandmasterDirectory(event.currentTarget.value));

$$('[data-close]').forEach(button => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 3200);
}

const lastUser = localStorage.getItem("replay:last-user");
if (lastUser) {
  $("#username").value = lastUser;
  $("#reportUsername").value = lastUser;
  $("#tacticsReportUsername").value = lastUser;
}
const restored = restoreProfileSession();
state.appUser = restored.profile;
state.guest = restored.guest;
if (!state.appUser && !state.guest) {
  state.guest = true;
  continueAsGuest();
}
loadAccountPreferences();
renderEngineChoices();
renderFeaturedMasters();
renderProfileChoices();
updateIdentityUI();
updateGameSourceUI();
updateReportSourceUI("wrapped");
updateReportSourceUI("tactics");
function setCloudAuthDisabled(disabled) {
  $$("[data-cloud-provider], #emailSignInChoice, #emailCreateChoice, #emailAuthForm input, #emailAuthForm button").forEach(control => {
    control.disabled = disabled;
  });
}
if (!cloudConfigured()) {
  setCloudAuthDisabled(true);
  $("#cloudAuthNote").textContent = "Cloud sign-in is ready for a Firebase web configuration in static/config.js.";
} else {
  setCloudAuthDisabled(true);
  $("#cloudAuthNote").textContent = "Google and email/password accounts are remembered securely by Firebase.";
  initCloudSession(async user => {
    if (user) await activateCloudUser(user);
    else if (lastCloudUserId && state.appUser?.storage === "cloud") {
      lastCloudUserId = null;
      clearProfileSession();
      enterGuestSession();
      showToast("Signed out. Continuing as guest.");
    }
  }).then(() => {
    setCloudAuthDisabled(false);
  }).catch(error => {
    $("#cloudAuthNote").textContent = error.message;
    setCloudAuthDisabled(true);
  });
}
trainingArrowLayer = createBoardArrows({
  board: $("#board"),
  svg: $("#arrows"),
  squareSelector: ".square",
  squareData: "square",
  isFlipped: () => state.current?.game.playerColor === "black",
});
systemColorScheme?.addEventListener?.("change", () => {
  if ((state.prefs.siteTheme || "system") === "system") applyPreferences();
});
renderBoard();
showAnalysis();
