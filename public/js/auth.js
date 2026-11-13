// Customer sign-in with Firebase Authentication: Google, email/password, or guest (anonymous).
// A guest who later signs in keeps their details and orders (account linking / merge).
const SDK = 'https://www.gstatic.com/firebasejs/11.0.2';

let fb = null; // { auth, m }  m = firebase-auth module
let readyPromise = null;
const listeners = new Set();

export function initAuth(accountsCfg, lang = 'en') {
  if (!accountsCfg) return Promise.resolve(null);
  readyPromise ??= (async () => {
    try {
      const [{ initializeApp }, m] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`)]);
      const app = initializeApp({
        apiKey: accountsCfg.apiKey, authDomain: accountsCfg.authDomain, projectId: accountsCfg.projectId, appId: accountsCfg.appId,
      });
      const auth = m.getAuth(app);
      auth.languageCode = lang;
      fb = { auth, m };
      await new Promise((resolve) => {
        const off = m.onAuthStateChanged(auth, (u) => { off(); resolve(u); });
      });
      m.onAuthStateChanged(auth, (u) => listeners.forEach((fn) => fn(u)));
      return auth;
    } catch (e) {
      console.warn('Sign-in unavailable:', e.message);
      return null;
    }
  })();
  return readyPromise;
}

export const authReady = () => readyPromise || Promise.resolve(null);
export const currentUser = () => fb?.auth.currentUser || null;
export const onUserChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const setAuthLang = (l) => { if (fb) fb.auth.languageCode = l; };

export async function getToken() {
  const u = currentUser();
  return u ? u.getIdToken() : null;
}

async function mergeFrom(guestToken) {
  const token = await getToken();
  await fetch('/api/me/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ guestToken }),
  }).catch(() => {});
}

export async function signInGoogle() {
  const { auth, m } = fb;
  const provider = new m.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const u = auth.currentUser;
  if (u?.isAnonymous) {
    try {
      await m.linkWithPopup(u, provider); // guest becomes a Google account, same uid
      await u.getIdToken(true);
      return;
    } catch (e) {
      if (e.code !== 'auth/credential-already-in-use') throw e;
      // That Google account already exists: sign in to it and move the guest's data over.
      const guestToken = await u.getIdToken();
      await m.signInWithCredential(auth, m.GoogleAuthProvider.credentialFromError(e));
      await mergeFrom(guestToken);
      return;
    }
  }
  await m.signInWithPopup(auth, provider);
}

export async function registerEmail(email, password) {
  const { auth, m } = fb;
  const u = auth.currentUser;
  if (u?.isAnonymous) {
    await m.linkWithCredential(u, m.EmailAuthProvider.credential(email, password));
    await u.getIdToken(true);
    return;
  }
  await m.createUserWithEmailAndPassword(auth, email, password);
}

export async function signInEmail(email, password) {
  const { auth, m } = fb;
  const u = auth.currentUser;
  const guestToken = u?.isAnonymous ? await u.getIdToken() : null;
  await m.signInWithEmailAndPassword(auth, email, password);
  if (guestToken) await mergeFrom(guestToken);
}

export const signInGuest = () => fb.m.signInAnonymously(fb.auth);
export const resetPassword = (email) => fb.m.sendPasswordResetEmail(fb.auth, email);
export const signOutUser = () => fb.m.signOut(fb.auth);

export async function deleteFirebaseUser() {
  const u = currentUser();
  if (u) await u.delete();
}

/** Firebase error code -> i18n key */
export function authErrorKey(e) {
  const map = {
    'auth/invalid-email': 'ae_email',
    'auth/missing-email': 'ae_email',
    'auth/invalid-credential': 'ae_wrong',
    'auth/wrong-password': 'ae_wrong',
    'auth/user-not-found': 'ae_wrong',
    'auth/missing-password': 'ae_weak',
    'auth/weak-password': 'ae_weak',
    'auth/email-already-in-use': 'ae_exists',
    'auth/credential-already-in-use': 'ae_exists',
    'auth/popup-blocked': 'ae_popup',
    'auth/network-request-failed': 'e_net',
    'auth/too-many-requests': 'e_rate_limited',
    'auth/unauthorized-domain': 'ae_domain',
    'auth/operation-not-allowed': 'ae_disabled',
    'auth/requires-recent-login': 'ae_recent',
  };
  return map[e?.code] || 'ae_generic';
}

export const isCancel = (e) => ['auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(e?.code);
