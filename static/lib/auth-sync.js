import { replayConfig } from "../config.js";

let firebase = null;
let auth = null;
let db = null;
let activeUser = null;
let authReadyResolve;
const authReady = new Promise(resolve => { authReadyResolve = resolve; });
const pendingWrites = new Map();
let flushTimer = null;

export function cloudConfigured() {
  const config = replayConfig.firebase;
  return Boolean(config?.apiKey && config?.authDomain && config?.projectId && config?.appId);
}

function moduleUrl(service) {
  return `https://www.gstatic.com/firebasejs/${replayConfig.firebaseSdkVersion}/${service}.js`;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.uid,
    username: user.displayName || user.email?.split("@")[0] || "DoBackChess player",
    email: user.email || "",
    photoURL: user.photoURL || "",
    storage: "cloud",
    providers: user.providerData.map(item => item.providerId),
  };
}

export async function initCloudSession(onChange) {
  if (!cloudConfigured()) {
    authReadyResolve(null);
    onChange?.(null);
    return { configured: false, user: null };
  }
  try {
    const [appModule, authModule, firestoreModule] = await Promise.all([
      import(moduleUrl("firebase-app")),
      import(moduleUrl("firebase-auth")),
      import(moduleUrl("firebase-firestore")),
    ]);
    firebase = { ...authModule, ...firestoreModule };
    const app = appModule.initializeApp(replayConfig.firebase);
    auth = authModule.getAuth(app);
    await authModule.setPersistence(auth, authModule.browserLocalPersistence);
    authModule.useDeviceLanguage(auth);
    await authModule.getRedirectResult(auth);
    try {
      db = firestoreModule.initializeFirestore(app, {
        localCache: firestoreModule.persistentLocalCache({
          tabManager: firestoreModule.persistentMultipleTabManager(),
        }),
      });
    } catch (error) {
      console.warn("Persistent Firestore cache is unavailable; using the in-memory cache.", error);
      db = firestoreModule.getFirestore(app);
    }
    authModule.onAuthStateChanged(auth, user => {
      activeUser = user;
      const value = publicUser(user);
      authReadyResolve(value);
      onChange?.(value);
    });
    return { configured: true, user: await authReady };
  } catch (error) {
    console.error("DoBackChess cloud initialization failed", error);
    authReadyResolve(null);
    throw new Error("Cloud sign-in could not start. Check the Firebase configuration and authorized domains.");
  }
}

function providerFor(name) {
  if (name === "google") return new firebase.GoogleAuthProvider();
  throw new Error("Unsupported sign-in provider.");
}

export async function signInOrLink(name) {
  if (!auth || !firebase) throw new Error("Cloud accounts are not configured yet.");
  const provider = providerFor(name);
  if (auth.currentUser) {
    if (auth.currentUser.providerData.some(item => item.providerId === provider.providerId)) return publicUser(auth.currentUser);
    const result = await firebase.linkWithPopup(auth.currentUser, provider);
    activeUser = result.user;
    return publicUser(result.user);
  }
  try {
    const result = await firebase.signInWithPopup(auth, provider);
    activeUser = result.user;
    return publicUser(result.user);
  } catch (error) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(error.code)) {
      await firebase.signInWithRedirect(auth, provider);
      return null;
    }
    if (error.code === "auth/account-exists-with-different-credential") {
      const email = error.customData?.email;
      throw new Error(`${email || "That email"} already has a DoBackChess account. Sign in with email and password, then link Google from Settings.`);
    }
    throw friendlyAuthError(error);
  }
}

export async function signInWithEmail(email, password) {
  if (!auth || !firebase) throw new Error("Cloud accounts are not configured yet.");
  try {
    const result = await firebase.signInWithEmailAndPassword(auth, String(email || "").trim(), String(password || ""));
    activeUser = result.user;
    return publicUser(result.user);
  } catch (error) {
    throw friendlyAuthError(error);
  }
}

export async function createEmailAccount(email, password) {
  if (!auth || !firebase) throw new Error("Cloud accounts are not configured yet.");
  try {
    const result = await firebase.createUserWithEmailAndPassword(auth, String(email || "").trim(), String(password || ""));
    activeUser = result.user;
    return publicUser(result.user);
  } catch (error) {
    throw friendlyAuthError(error);
  }
}

export async function sendEmailPasswordReset(email) {
  if (!auth || !firebase) throw new Error("Cloud accounts are not configured yet.");
  const normalized = String(email || "").trim();
  if (!normalized) throw new Error("Enter your email address first.");
  try {
    await firebase.sendPasswordResetEmail(auth, normalized);
  } catch (error) {
    throw friendlyAuthError(error);
  }
}

export function friendlyAuthError(error) {
  if (["auth/popup-closed-by-user", "auth/cancelled-popup-request"].includes(error.code)) return new Error("Sign-in was cancelled.");
  if (error.code === "auth/unauthorized-domain") return new Error("This site is not yet listed as an authorized Firebase sign-in domain.");
  if (error.code === "auth/credential-already-in-use") return new Error("That sign-in is already linked to another DoBackChess account.");
  if (error.code === "auth/email-already-in-use") return new Error("That email already has a DoBackChess account. Sign in instead.");
  if (error.code === "auth/invalid-email") return new Error("Enter a valid email address.");
  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"].includes(error.code)) return new Error("The email or password is incorrect.");
  if (error.code === "auth/weak-password") return new Error("Use a password with at least six characters.");
  if (error.code === "auth/missing-password") return new Error("Enter your password.");
  if (error.code === "auth/user-disabled") return new Error("This DoBackChess account has been disabled.");
  if (error.code === "auth/too-many-requests") return new Error("Too many sign-in attempts. Wait a moment and try again.");
  return new Error(error.message || "Sign-in failed.");
}

export async function signOutCloud() {
  if (auth) await firebase.signOut(auth);
}

function stateDoc(key) {
  if (!db || !activeUser) return null;
  const id = encodeURIComponent(key).replaceAll("%", "_").slice(0, 900);
  return firebase.doc(db, "users", activeUser.uid, "state", id);
}

export async function loadCloudJson(key, fallback = null) {
  await authReady;
  const reference = stateDoc(key);
  if (!reference) return fallback;
  try {
    const snapshot = await firebase.getDoc(reference);
    return snapshot.exists() ? snapshot.data().value ?? fallback : fallback;
  } catch (error) {
    console.warn("DoBackChess cloud read failed", error);
    return fallback;
  }
}

function syncableKey(key) {
  return ["replay:prefs:", "replay:schedule:", "replay:library:", "replay:played-games:", "replay:report:"]
    .some(prefix => key.startsWith(prefix));
}

export function queueCloudJson(key, value) {
  if (!activeUser || !syncableKey(key)) return;
  pendingWrites.set(key, value);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushCloudWrites, 450);
}

export async function flushCloudWrites() {
  if (!activeUser || !pendingWrites.size) return;
  const writes = [...pendingWrites.entries()];
  pendingWrites.clear();
  await Promise.all(writes.map(async ([key, value]) => {
    const reference = stateDoc(key);
    if (!reference) return;
    try {
      await firebase.setDoc(reference, {
        key,
        value,
        updatedAt: firebase.serverTimestamp(),
        schemaVersion: 1,
      }, { merge: true });
    } catch (error) {
      console.warn("DoBackChess cloud write failed", error);
    }
  }));
}

export function currentCloudUser() {
  return publicUser(activeUser);
}
