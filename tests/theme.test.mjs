import assert from "node:assert/strict";
import test from "node:test";
import { resolveSiteTheme } from "../static/lib/theme.js";

test("system theme follows the operating-system color preference", () => {
  assert.equal(resolveSiteTheme("system", false), "light");
  assert.equal(resolveSiteTheme("system", true), "dark");
});

test("explicit themes override the operating-system preference", () => {
  assert.equal(resolveSiteTheme("light", true), "light");
  assert.equal(resolveSiteTheme("dark", false), "dark");
  assert.equal(resolveSiteTheme("warm", true), "warm");
});

test("missing preferences default to the system color preference", () => {
  assert.equal(resolveSiteTheme(undefined, false), "light");
  assert.equal(resolveSiteTheme(undefined, true), "dark");
});
