import assert from "node:assert/strict";
import test from "node:test";
import { getGameDetail, getGameRecord, importPgnText, normalizeReportGameLimit, reportSelectionCount, splitPgnGames } from "../static/lib/game-import.js";

const TOURNAMENT_PGN = `[Event "County Championship"]
[Site "Lexington, KY"]
[Date "2026.07.12"]
[White "Alice Example"]
[Black "Bob Example"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0

[Event "Weekend Swiss"]
[Date "2026.07.13"]
[White "Carol Example"]
[Black "Alice Example"]
[Result "1/2-1/2"]

1. d4 d5 2. c4 e6 3. Nc3 Nf6 1/2-1/2`;

test("splits and imports multiple tournament PGNs from the named player's perspective", async () => {
  assert.equal(splitPgnGames(TOURNAMENT_PGN).length, 2);
  const imported = await importPgnText({ text: TOURNAMENT_PGN, playerName: "Alice Example" });
  assert.equal(imported.games.length, 2);
  assert.equal(imported.playerName, "Alice Example");
  assert.deepEqual(imported.games.map(game => game.playerColor), ["white", "black"]);
  assert.deepEqual(imported.games.map(game => game.opponent), ["Bob Example", "Carol Example"]);
  assert.equal(getGameDetail(imported.games[0].id).moves.length, 6);
  const record = getGameRecord(imported.games[0].id);
  assert.match(record.pgn, /County Championship/);
  assert.equal(record.summary.opponent, "Bob Example");
  record.summary.opponent = "Changed copy";
  assert.equal(getGameRecord(imported.games[0].id).summary.opponent, "Bob Example");
});

test("accepts straight SAN notation and applies the selected fallback color", async () => {
  const imported = await importPgnText({
    text: "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6",
    fallbackColor: "black",
  });
  assert.equal(imported.games.length, 1);
  assert.equal(imported.playerName, "Imported player");
  assert.equal(imported.games[0].playerColor, "black");
  assert.equal(getGameDetail(imported.games[0].id).moves.at(-1).san, "a6");
});

test("rejects empty and unplayable tournament input with explicit messages", async () => {
  await assert.rejects(importPgnText({ text: "" }), /Choose a PGN file or paste tournament notation/);
  await assert.rejects(importPgnText({ text: "This is not a chess score" }), /legal standard chess game/);
  assert.throws(() => getGameRecord("missing"), /Refresh your game history/);
});

test("training uses a configurable 20-to-50 game floor while retaining larger seven-day sets", () => {
  const cutoff = 1_000;
  const sixtyRecent = Array.from({ length: 80 }, (_, index) => ({ ended: index < 60 ? 1_200 : 900 }));
  const tenRecent = Array.from({ length: 80 }, (_, index) => ({ ended: index < 10 ? 1_200 : 900 }));
  assert.equal(reportSelectionCount(sixtyRecent, game => game.ended, cutoff), 60);
  assert.equal(reportSelectionCount(tenRecent, game => game.ended, cutoff), 20);
  assert.equal(reportSelectionCount(tenRecent, game => game.ended, cutoff, 50), 50);
  assert.equal(reportSelectionCount(tenRecent.slice(0, 32), game => game.ended, cutoff, 50), 32);
  assert.equal(normalizeReportGameLimit(10), 20);
  assert.equal(normalizeReportGameLimit(35), 35);
  assert.equal(normalizeReportGameLimit(99), 50);
});
