/**
 * Public, deploy-time configuration.
 *
 * Keep secrets out of this file: everything in `static/` is visible to every
 * visitor. Remote engine endpoints should authenticate a DoBackChess user and keep
 * provider credentials, billing, and quotas on the server side.
 */
const defaults = {
  accountApiBase: "",
  browserReckless: {
    // Reckless depth is not directly comparable to Stockfish depth. This is the
    // Balanced fixed-node budget; Quick and Deep use their own tested limits.
    nodes: 750000,
  },
  firebase: {
    apiKey: "AIzaSyAKdYlQa1nbtVmakM5EP2IjjCP1pjkKQ6s",
    authDomain: "doback-chess.firebaseapp.com",
    projectId: "doback-chess",
    storageBucket: "doback-chess.firebasestorage.app",
    messagingSenderId: "959919406663",
    appId: "1:959919406663:web:24fa43e89657c48478bb62",
    measurementId: "G-S5NML9MZ27",
  },
  firebaseSdkVersion: "12.16.0",
  browserEngines: {
    reckless: {
      // The complete alpha package is vendored on main and loads only when used.
      enabled: true,
      assetBaseUrl: "./vendor/reckless/",
    },
  },
  remoteEngines: [
    {
      id: "lc0",
      name: "Lc0 cloud",
      tier: "plus",
      endpoint: "",
      description: "Neural-network analysis through a configured compute service.",
      sourceUrl: "https://github.com/LeelaChessZero/lc0",
      license: "GPL-3.0-or-later",
    },
    {
      id: "reckless",
      name: "Reckless cloud",
      tier: "plus",
      endpoint: "",
      description: "Reckless engine analysis through a configured compute service.",
      sourceUrl: "https://github.com/codedeliveryservice/Reckless",
      license: "AGPL-3.0",
    },
  ],
};

const overrides = globalThis.REPLAY_CONFIG || {};

export const replayConfig = Object.freeze({
  ...defaults,
  ...overrides,
  browserReckless: { ...defaults.browserReckless, ...(overrides.browserReckless || {}) },
  browserEngines: {
    ...defaults.browserEngines,
    ...(overrides.browserEngines || {}),
    reckless: {
      ...defaults.browserEngines.reckless,
      ...(overrides.browserEngines?.reckless || {}),
    },
  },
  remoteEngines: overrides.remoteEngines || defaults.remoteEngines,
});
