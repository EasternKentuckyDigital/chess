import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { friendlyAuthError } from "../static/lib/auth-sync.js";

test("email authentication errors are safe and understandable", () => {
  assert.equal(friendlyAuthError({ code: "auth/email-already-in-use" }).message, "That email already has a DoBackChess account. Sign in instead.");
  assert.equal(friendlyAuthError({ code: "auth/invalid-credential" }).message, "The email or password is incorrect.");
  assert.equal(friendlyAuthError({ code: "auth/weak-password" }).message, "Use a password with at least six characters.");
  assert.equal(friendlyAuthError({ code: "auth/too-many-requests" }).message, "Too many sign-in attempts. Wait a moment and try again.");
});

test("the account UI offers Google and email/password without GitHub login", async () => {
  const [html, authSource] = await Promise.all([
    readFile(new URL("../static/index.html", import.meta.url), "utf8"),
    readFile(new URL("../static/lib/auth-sync.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /data-cloud-provider="google"/);
  assert.match(html, /id="emailAuthForm"/);
  assert.match(html, /id="emailCreateButton"/);
  assert.match(html, /id="emailResetButton"/);
  assert.doesNotMatch(html, /data-cloud-provider="github"/);
  assert.doesNotMatch(html, /data-link-provider="github"/);
  assert.doesNotMatch(authSource, /GithubAuthProvider/);
});
