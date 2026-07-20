import assert from "node:assert/strict";
import test from "node:test";
import { CLOUD_LIBRARY_LIMIT, DEVICE_LIBRARY_LIMIT, retainedLibraryRecords } from "../static/lib/library-storage.js";

const records = count => Array.from({ length: count }, (_, index) => ({ id: `game-${index}`, pgn: "1. e4 e5", summary: { endTime: count - index } }));

test("signed-in accounts retain substantially larger game libraries", () => {
  const source = records(CLOUD_LIBRARY_LIMIT + 20);
  assert.equal(retainedLibraryRecords(source, [], { cloud: true }).length, CLOUD_LIBRARY_LIMIT);
  assert.equal(retainedLibraryRecords(source, [], { cloud: false }).length, DEVICE_LIBRARY_LIMIT);
});

test("new imports take priority, merge without duplicates, and respect the byte budget", () => {
  const current = [{ id: "new", pgn: "x".repeat(40) }, { id: "same", pgn: "new" }];
  const previous = [{ id: "same", pgn: "old" }, { id: "older", pgn: "x".repeat(100) }];
  const retained = retainedLibraryRecords(current, previous, { cloud: true, byteBudget: 130 });
  assert.deepEqual(retained.map(item => item.id), ["new", "same"]);
  assert.equal(retained[1].pgn, "new");
});
