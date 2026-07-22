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

test("board shells resize as one square instead of letting tiles drive layout", async () => {
  const css = await readFile(new URL("../static/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.board-shell \{[^}]*aspect-ratio: 1 \/ 1;[^}]*contain: strict;/);
  assert.match(css, /\.board \{[^}]*position: absolute;[^}]*inset: 0;/);
  assert.match(css, /\.square \{[^}]*aspect-ratio: auto;/);
  assert.match(css, /\.analysis-board-frame \{[^}]*width: min\(100%,clamp\(280px,calc\(100vh - 132px\),800px\)\)/);
  assert.match(css, /\.play-board-shell \{[^}]*width: min\(100%,clamp\(280px,calc\(100vh - 148px\),684px\)\);[^}]*height: auto;/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.analysis-board-frame \{ width: min\(100%,clamp\(260px,calc\(100vh - 150px\),680px\)\)/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.play-board-shell \{ width: min\(100%,clamp\(260px,calc\(100vh - 166px\),680px\)\)/);
});

test("the home page exposes every major study surface and analysis review stays readable", async () => {
  const [html, css, analysisBoard] = await Promise.all([
    readFile(new URL("../static/index.html", import.meta.url), "utf8"),
    readFile(new URL("../static/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../static/lib/analysis-board.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /href="#home" id="brandHome"/);
  for (const view of ["analysis", "play", "review", "report", "masters", "about"]) {
    assert.match(html, new RegExp(`data-home-view="${view}"`));
  }
  assert.match(css, /body\.analysis-room \{ overflow: auto; \}/);
  assert.match(css, /grid-template-columns: minmax\(480px,1fr\) minmax\(460px,620px\)/);
  assert.match(analysisBoard, /Choose a theme to see every missed move/);
  assert.match(analysisBoard, /data-review-theme=/);
  assert.match(analysisBoard, /data-review-ply=/);
  assert.match(analysisBoard, /All costly moves/);
});
