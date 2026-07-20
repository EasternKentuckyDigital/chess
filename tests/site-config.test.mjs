import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the GitHub Pages artifact declares the production custom domain", async () => {
  const cname = await readFile(new URL("../static/CNAME", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.equal(cname.trim(), "dobackchess.com");
  assert.match(workflow, /path: static/);
});

test("the public site exposes complete crawl and social metadata", async () => {
  const [html, robots, sitemap] = await Promise.all([
    readFile(new URL("../static/index.html", import.meta.url), "utf8"),
    readFile(new URL("../static/robots.txt", import.meta.url), "utf8"),
    readFile(new URL("../static/sitemap.xml", import.meta.url), "utf8"),
  ]);
  assert.match(html, /<link rel="canonical" href="https:\/\/dobackchess\.com\/">/);
  assert.match(html, /<meta name="description" content="[^"]+">/);
  assert.match(html, /<meta property="og:title" content="[^"]+">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/dobackchess\.com\/">/);
  assert.match(html, /<meta name="twitter:card" content="summary">/);
  const structuredData = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(structuredData, "expected JSON-LD structured data");
  const schema = JSON.parse(structuredData);
  assert.equal(schema["@type"], "WebApplication");
  assert.equal(schema.url, "https://dobackchess.com/");
  assert.equal(schema.isAccessibleForFree, true);
  assert.match(robots, /Allow: \//);
  assert.match(robots, /Sitemap: https:\/\/dobackchess\.com\/sitemap\.xml/);
  assert.match(sitemap, /<loc>https:\/\/dobackchess\.com\/<\/loc>/);
});

test("the training board stays in its full-size grid column while the eval bar is hidden", async () => {
  const css = await readFile(new URL("../static/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.training-board-frame > \.eval-bar \{ grid-column:1; grid-row:1; \}/);
  assert.match(css, /\.training-board-frame > \.board-shell \{[^}]*grid-column:2; grid-row:1;/);
});
