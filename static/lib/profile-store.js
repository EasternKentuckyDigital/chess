const ACTIVE_PROFILE_KEY = "replay:active-profile";
const PROFILES_KEY = "replay:device-profiles";
const GUEST_KEY = "replay:guest";

export const FREE_ENTITLEMENTS = Object.freeze({
  plan: "free",
  premiumActive: false,
  premiumSince: null,
  premiumLapsedAt: null,
  enginePolicy: "premium-analysis-stops-on-lapse",
  cachedPremiumDecksRemainVisible: true,
});

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function profileId() {
  if (globalThis.crypto?.randomUUID) return `device:${globalThis.crypto.randomUUID()}`;
  return `device:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizeProfile(profile) {
  if (!profile) return null;
  return {
    ...profile,
    entitlements: { ...FREE_ENTITLEMENTS, ...(profile.entitlements || {}) },
  };
}

export function cleanProfileName(value) {
  const name = String(value || "").trim();
  if (!/^[\p{L}\p{N}_ -]{2,32}$/u.test(name)) {
    throw new Error("Profile names must be 2–32 letters, numbers, spaces, dashes, or underscores.");
  }
  return name;
}

export function createDeviceProfile(value) {
  const username = cleanProfileName(value);
  const profile = { id: profileId(), username, storage: "device", entitlements: { ...FREE_ENTITLEMENTS } };
  const profiles = readJson(PROFILES_KEY, []);
  profiles.push(profile);
  writeJson(PROFILES_KEY, profiles.slice(-12));
  writeJson(ACTIVE_PROFILE_KEY, profile);
  localStorage.removeItem(GUEST_KEY);
  return profile;
}

export function listDeviceProfiles() {
  return readJson(PROFILES_KEY, []).map(normalizeProfile);
}

export function activateDeviceProfile(id) {
  const profile = listDeviceProfiles().find(candidate => candidate.id === id);
  if (!profile) throw new Error("That device profile is no longer available.");
  writeJson(ACTIVE_PROFILE_KEY, profile);
  localStorage.removeItem(GUEST_KEY);
  return profile;
}

export function restoreProfileSession() {
  const profile = normalizeProfile(readJson(ACTIVE_PROFILE_KEY, null));
  const guest = !profile && localStorage.getItem(GUEST_KEY) === "1";
  return { profile, guest };
}

export function continueAsGuest() {
  localStorage.removeItem(ACTIVE_PROFILE_KEY);
  localStorage.setItem(GUEST_KEY, "1");
}

export function clearProfileSession() {
  localStorage.removeItem(ACTIVE_PROFILE_KEY);
  localStorage.removeItem(GUEST_KEY);
}

export function hasPremiumEntitlement(profile) {
  return Boolean(profile?.entitlements?.premiumActive);
}
