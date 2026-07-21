import { Chess } from "../vendor/chess/chess.js";

const WEEK_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_REPORT_GAMES = 20;
export const MAX_REPORT_GAMES = 50;
const records = new Map();
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function cleanUsername(value) {
  const username = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(username)) {
    throw new Error("Enter a valid Chess.com or Lichess username.");
  }
  return username;
}

async function fetchResponse(url, accept) {
  let response;
  try {
    response = await fetch(url, { headers: accept ? { Accept: accept } : undefined });
  } catch {
    throw new Error("Could not reach the game service. Check your internet connection.");
  }
  if (response.ok) return response;
  if (response.status === 404) throw new Error("That username was not found.");
  if (response.status === 429) throw new Error("The game service is rate-limiting requests. Wait a minute and try again.");
  throw new Error(`The game service returned an error (${response.status}).`);
}

async function fetchJson(url) {
  return (await fetchResponse(url, "application/json")).json();
}

async function fetchText(url) {
  return (await fetchResponse(url, "application/x-chess-pgn")).text();
}

function resultForUser(result, isWhite) {
  if (result === "1/2-1/2") return "Draw";
  if ((result === "1-0" && isWhite) || (result === "0-1" && !isWhite)) return "Win";
  if (result === "1-0" || result === "0-1") return "Loss";
  return "—";
}

function parsePgn(pgn) {
  const chess = new Chess();
  try {
    chess.loadPgn(pgn);
  } catch {
    return null;
  }
  return chess;
}

async function stableId(seed) {
  if (globalThis.crypto?.subtle) {
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
    return [...new Uint8Array(bytes)].slice(0, 8).map(value => value.toString(16).padStart(2, "0")).join("");
  }
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function openingName(headers) {
  const ecoUrl = headers.ECOUrl || "";
  if (ecoUrl) {
    const slug = ecoUrl.replace(/\/$/, "").split("/").pop() || "";
    return decodeURIComponent(slug).replaceAll("-", " ");
  }
  return headers.Opening || headers.ECO || "Unknown opening";
}

function rating(value) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function lichessTimeClass(headers) {
  const event = (headers.Event || "").toLowerCase();
  return ["ultrabullet", "bullet", "blitz", "rapid", "classical", "correspondence"]
    .find(name => event.includes(name))?.replace(/^./, char => char.toUpperCase()) || "Game";
}

export function splitPgnGames(blob) {
  const source = String(blob || "").trim();
  if (!source) return [];
  const starts = [...source.matchAll(/^\[Event\s+"/gm)].map(match => match.index);
  if (!starts.length) return [source];
  return starts.map((start, index) => source.slice(start, starts[index + 1] ?? source.length).trim()).filter(Boolean);
}

function pgnTimestamp(headers) {
  const date = headers.UTCDate || headers.Date || "";
  const time = headers.UTCTime || "00:00:00";
  const parsed = Date.parse(`${date.replaceAll(".", "-")}T${time}Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function remember(record) {
  records.set(record.id, record);
  return record.summary;
}

async function chessComRecord(raw, username) {
  if (!raw.pgn || (raw.rules && raw.rules !== "chess")) return null;
  const parsed = parsePgn(raw.pgn);
  if (!parsed) return null;
  const headers = parsed.getHeaders();
  const white = raw.white || {};
  const black = raw.black || {};
  const isWhite = String(white.username || "").toLowerCase() === username.toLowerCase();
  const player = isWhite ? white : black;
  const opponent = isWhite ? black : white;
  const id = await stableId(`chesscom:${raw.url || ""}:${raw.pgn}`);
  const ended = Number(raw.end_time) || null;
  const summary = {
    id,
    opponent: opponent.username || "Unknown",
    opponentRating: rating(opponent.rating),
    playerRating: rating(player.rating),
    playerColor: isWhite ? "white" : "black",
    result: resultForUser(headers.Result || "*", isWhite),
    date: ended ? dateFormatter.format(new Date(ended * 1000)) : (headers.Date || "").replaceAll(".", "-"),
    timeClass: String(raw.time_class || "game").replace(/^./, char => char.toUpperCase()),
    timeControl: raw.time_control || "",
    opening: openingName(headers),
    endTime: ended,
    source: "chesscom",
  };
  return { id, username, pgn: raw.pgn, url: raw.url || "", summary };
}

export function normalizeReportGameLimit(value = DEFAULT_REPORT_GAMES) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_REPORT_GAMES;
  return Math.max(DEFAULT_REPORT_GAMES, Math.min(MAX_REPORT_GAMES, parsed));
}

export function reportSelectionCount(items, timestamp, cutoff, gameLimit = DEFAULT_REPORT_GAMES) {
  const minimumGames = normalizeReportGameLimit(gameLimit);
  const recentCount = items.filter(item => Number(timestamp(item)) >= cutoff).length;
  return Math.min(items.length, Math.max(minimumGames, recentCount));
}

async function importChessCom(username, scope = "recent", gameLimit = DEFAULT_REPORT_GAMES) {
  const base = `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}`;
  const archives = (await fetchJson(`${base}/games/archives`)).archives || [];
  if (!archives.length) {
    return {
      games: [],
      window: "No games found",
      emptyMessage: "That Chess.com account exists, but DoBackChess could not find any public standard games to import.",
    };
  }

  const minimumGames = normalizeReportGameLimit(gameLimit);
  const cutoff = Math.floor(Date.now() / 1000) - WEEK_SECONDS;
  const latestLimit = scope === "latest100" ? 100 : scope === "wrapped" ? minimumGames : scope === "latest" ? 20 : null;
  const reportMode = scope === "report";
  const rollingWindow = reportMode || scope === "recent";
  const rawGames = [];
  for (const archiveUrl of [...archives].reverse()) {
    const monthGames = (await fetchJson(archiveUrl)).games || [];
    rawGames.push(...[...monthGames].reverse());
    const oldest = Math.min(...monthGames.map(game => Number(game.end_time) || Number.POSITIVE_INFINITY));
    if (rollingWindow ? rawGames.length >= minimumGames && oldest < cutoff : rawGames.length >= latestLimit) break;
  }

  const recent = rawGames.filter(game => Number(game.end_time) >= cutoff);
  const selected = rollingWindow
    ? rawGames.slice(0, reportSelectionCount(rawGames, game => game.end_time, cutoff, minimumGames))
    : rawGames.slice(0, latestLimit);
  const games = [];
  for (const raw of selected) {
    const record = await chessComRecord(raw, username);
    if (record) games.push(remember(record));
  }
  return {
    games,
    window: rollingWindow
      ? (recent.length >= minimumGames ? `Last 7 days · ${games.length} games` : games.length < minimumGames ? `All ${games.length} available games` : `Latest ${minimumGames} games`)
      : games.length < latestLimit ? `All ${games.length} available games` : `Latest ${latestLimit} games`,
    notice: rollingWindow
      ? `${reportMode ? "Tactics Report" : "Training"} selected ${games.length} games: ${recent.length >= minimumGames ? "every public standard game from the last 7 days" : `the latest ${Math.min(minimumGames, games.length)}`}.`
      : scope === "wrapped" ? `Chess Report selected the latest ${games.length} public standard ${games.length === 1 ? "game" : "games"}.` : "",
    emptyMessage: "That Chess.com account was found, but DoBackChess could not import any public standard chess games.",
  };
}

async function importLichess(username, scope = "recent", gameLimit = DEFAULT_REPORT_GAMES) {
  await fetchJson(`https://lichess.org/api/user/${encodeURIComponent(username)}`);
  const minimumGames = normalizeReportGameLimit(gameLimit);
  const cutoffMs = Date.now() - WEEK_SECONDS * 1000;
  const latestLimit = scope === "latest100" ? 100 : scope === "wrapped" ? minimumGames : scope === "latest" ? 20 : null;
  const reportMode = scope === "report";
  const rollingWindow = reportMode || scope === "recent";
  const params = new URLSearchParams({
    opening: "true",
    moves: "true",
    clocks: "false",
    evals: "false",
  });
  if (rollingWindow) params.set("since", String(cutoffMs));
  else params.set("max", String(latestLimit));
  const base = `https://lichess.org/api/games/user/${encodeURIComponent(username)}`;
  let pgns = splitPgnGames(await fetchText(`${base}?${params}`));
  const recentCount = pgns.length;
  if (rollingWindow && pgns.length < minimumGames) {
    params.delete("since");
    params.set("max", String(minimumGames));
    pgns = splitPgnGames(await fetchText(`${base}?${params}`));
  }

  const games = [];
  const selectedPgns = rollingWindow ? pgns : pgns.slice(0, latestLimit);
  for (const pgn of selectedPgns) {
    const parsed = parsePgn(pgn);
    if (!parsed) continue;
    const headers = parsed.getHeaders();
    if (!["Standard", "From Position", undefined].includes(headers.Variant)) continue;
    const whiteName = headers.White || "Unknown";
    const blackName = headers.Black || "Unknown";
    const isWhite = whiteName.toLowerCase() === username.toLowerCase();
    const ended = pgnTimestamp(headers);
    const id = await stableId(`lichess:${headers.Site || ""}:${pgn}`);
    const summary = {
      id,
      opponent: isWhite ? blackName : whiteName,
      opponentRating: rating(headers[isWhite ? "BlackElo" : "WhiteElo"]),
      playerRating: rating(headers[isWhite ? "WhiteElo" : "BlackElo"]),
      playerColor: isWhite ? "white" : "black",
      result: resultForUser(headers.Result || "*", isWhite),
      date: ended ? dateFormatter.format(new Date(ended * 1000)) : (headers.UTCDate || headers.Date || "").replaceAll(".", "-"),
      timeClass: lichessTimeClass(headers),
      timeControl: headers.TimeControl || "",
      opening: headers.Opening || headers.ECO || "Unknown opening",
      endTime: ended,
      source: "lichess",
    };
    remember({ id, username, pgn, url: headers.Site || "", summary });
    games.push(summary);
  }
  return {
    games,
    window: rollingWindow
      ? (recentCount >= minimumGames ? `Last 7 days · ${games.length} games` : games.length < minimumGames ? `All ${games.length} available games` : `Latest ${minimumGames} games`)
      : games.length < latestLimit ? `All ${games.length} available games` : `Latest ${latestLimit} games`,
    notice: rollingWindow
      ? `${reportMode ? "Tactics Report" : "Training"} selected ${games.length} games: ${recentCount >= minimumGames ? "every public standard game from the last 7 days" : `the latest ${Math.min(minimumGames, games.length)}`}.`
      : scope === "wrapped" ? `Chess Report selected the latest ${games.length} public standard ${games.length === 1 ? "game" : "games"}.` : "",
    emptyMessage: "That Lichess account was found, but DoBackChess could not import any public standard chess games.",
  };
}

export async function importPgnText({ text, playerName = "", fallbackColor = "white" }) {
  const pgns = splitPgnGames(text);
  if (!pgns.length) throw new Error("Choose a PGN file or paste tournament notation first.");
  if (!["white", "black"].includes(fallbackColor)) throw new Error("Choose whether the imported player is White or Black.");

  records.clear();
  const requestedName = String(playerName || "").trim();
  let resolvedName = requestedName;
  const games = [];

  for (let index = 0; index < pgns.length; index += 1) {
    const pgn = pgns[index];
    const parsed = parsePgn(pgn);
    if (!parsed || !parsed.history().length) continue;
    const headers = parsed.getHeaders();
    if (headers.Variant && !["Standard", "From Position"].includes(headers.Variant)) continue;

    const whiteName = headers.White && headers.White !== "?" ? headers.White : "White";
    const blackName = headers.Black && headers.Black !== "?" ? headers.Black : "Black";
    const requested = requestedName.toLowerCase();
    const matchesWhite = requested && whiteName.toLowerCase() === requested;
    const matchesBlack = requested && blackName.toLowerCase() === requested;
    const isWhite = matchesWhite || (!matchesBlack && fallbackColor === "white");
    const studiedName = isWhite ? whiteName : blackName;
    if (!resolvedName && !["White", "Black"].includes(studiedName)) resolvedName = studiedName;

    const id = await stableId(`pgn:${index}:${pgn}`);
    const ended = pgnTimestamp(headers);
    const summary = {
      id,
      opponent: isWhite ? blackName : whiteName,
      opponentRating: rating(headers[isWhite ? "BlackElo" : "WhiteElo"]),
      playerRating: rating(headers[isWhite ? "WhiteElo" : "BlackElo"]),
      playerColor: isWhite ? "white" : "black",
      result: resultForUser(headers.Result || "*", isWhite),
      date: ended ? dateFormatter.format(new Date(ended * 1000)) : (headers.Date && !headers.Date.includes("?") ? headers.Date.replaceAll(".", "-") : "Imported game"),
      timeClass: headers.Event && headers.Event !== "?" ? headers.Event : "Tournament game",
      timeControl: headers.TimeControl || "",
      opening: openingName(headers),
      endTime: ended,
      source: "pgn",
    };
    const username = requestedName || resolvedName || (!["White", "Black"].includes(studiedName) ? studiedName : "Imported player");
    remember({ id, username, pgn, url: /^https?:\/\//i.test(headers.Site || "") ? headers.Site : "", summary });
    games.push(summary);
  }

  if (!games.length) throw new Error("DoBackChess could not find a legal standard chess game in that PGN or notation.");
  const finalName = requestedName || resolvedName || "Imported player";
  return {
    games,
    playerName: finalName,
    window: `${games.length} imported tournament ${games.length === 1 ? "game" : "games"}`,
    notice: `Imported ${games.length} ${games.length === 1 ? "game" : "games"} from PGN or notation.`,
    emptyMessage: "DoBackChess could not find a legal standard chess game in that PGN or notation.",
  };
}

export async function importGames({ username: rawUsername, source = "chesscom", scope = "recent", gameLimit = DEFAULT_REPORT_GAMES }) {
  const username = cleanUsername(rawUsername);
  records.clear();
  if (source === "chesscom") return importChessCom(username, scope, gameLimit);
  if (source === "lichess") return importLichess(username, scope, gameLimit);
  throw new Error("Choose Chess.com or Lichess as the game source.");
}

export function exportImportedGames() {
  return [...records.values()].map(record => ({
    id: record.id,
    username: record.username,
    pgn: record.pgn,
    url: record.url,
    summary: record.summary,
  }));
}

export function restoreImportedGames(savedRecords) {
  records.clear();
  for (const record of Array.isArray(savedRecords) ? savedRecords : []) {
    if (!record?.id || !record?.pgn || !record?.summary) continue;
    records.set(record.id, record);
  }
  return [...records.values()].map(record => record.summary);
}

export function getGameDetail(id) {
  const record = records.get(id);
  if (!record) throw new Error("Game not found. Import your games again.");
  const parsed = parsePgn(record.pgn);
  if (!parsed) throw new Error("That game could not be parsed.");
  const headers = parsed.getHeaders();
  const replay = headers.FEN ? new Chess(headers.FEN) : new Chess();
  const frames = [{ fen: replay.fen(), lastMove: null, san: null, ply: 0 }];
  const moves = parsed.history({ verbose: true }).map((move, index) => {
    const played = replay.move({ from: move.from, to: move.to, promotion: move.promotion });
    const uci = `${move.from}${move.to}${move.promotion || ""}`;
    const item = { fen: replay.fen(), lastMove: uci.slice(0, 4), san: played.san, ply: index + 1, uci };
    frames.push(item);
    return item;
  });
  return { summary: record.summary, frames, moves, url: record.url };
}

export function getGameRecord(id) {
  const record = records.get(id);
  if (!record) throw new Error("Game not found. Refresh your game history and try again.");
  return {
    id: record.id,
    username: record.username,
    pgn: record.pgn,
    url: record.url,
    summary: { ...record.summary },
  };
}
