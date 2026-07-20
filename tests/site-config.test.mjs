import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the GitHub Pages artifact declares the production custom domain", async () => {
  const cname = await readFile(new URL("../static/CNAME", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.equal(cname.trim(), "dobackchess.com");
  assert.match(workflow, /path: static/);
});
