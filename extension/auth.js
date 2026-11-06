import { SUPABASE_URL, SUPABASE_ANON_KEY, GOOGLE_OAUTH_CLIENT_ID } from "./config.js";

const SESSION_KEY = "pt_session";

export async function getSession() {
  const data = await chrome.storage.local.get(SESSION_KEY);
  return data[SESSION_KEY] || null;
}

export async function setSession(session) {
  if (!session) {
    await chrome.storage.local.remove(SESSION_KEY);
    return;
  }
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

export async function clearSession() {
  await chrome.storage.local.remove(SESSION_KEY);
}

export function getRedirectUrl() {
  return `https://${chrome.runtime.id}.chromiumapp.org`;
}

async function fetchUser(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: SUPABASE_ANON_KEY,
    },
  });
  if (!res.ok) throw new Error("사용자 정보를 가져오지 못했습니다");
  return res.json();
}

export async function refreshSessionIfNeeded() {
  const session = await getSession();
  if (!session?.refresh_token) return null;
  if (session.expires_at && session.expires_at > Date.now() + 60_000) {
    return session;
  }

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  if (!res.ok) {
    await clearSession();
    return null;
  }
  const json = await res.json();
  const next = {
    access_token: json.access_token,
    refresh_token: json.refresh_token || session.refresh_token,
    expires_at: Date.now() + (json.expires_in || 3600) * 1000,
    user: json.user || session.user,
  };
  if (!next.user) {
    next.user = await fetchUser(next.access_token);
  }
  await setSession(next);
  return next;
}

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function exchangeGoogleIdToken(idToken, nonce) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=id_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      provider: "google",
      id_token: idToken,
      nonce,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error_description || json?.msg || json?.error || "Supabase 로그인 실패");
  }
  return json;
}

// chrome.identity allows only one launchWebAuthFlow at a time. The popup
// closes as soon as the Google window takes focus, so a user reopening the
// popup and clicking again used to start a second flow. Share one in-flight
// promise instead.
let inflightSignIn = null;

export function isSigningIn() {
  return Boolean(inflightSignIn);
}

export function signInWithGoogle() {
  if (!inflightSignIn) {
    inflightSignIn = doSignInWithGoogle().finally(() => {
      inflightSignIn = null;
    });
  }
  return inflightSignIn;
}

async function doSignInWithGoogle() {
  const clientId = (GOOGLE_OAUTH_CLIENT_ID || "").trim();
  if (!clientId) {
    throw new Error("config.js에 GOOGLE_OAUTH_CLIENT_ID를 넣어주세요");
  }

  const redirectUri = getRedirectUrl();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "id_token");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("prompt", "select_account");
  // Google requires nonce for response_type=id_token and copies this value
  // into the token. Supabase hashes the raw nonce and compares. Send the
  // hash to Google and the raw value to Supabase.
  const rawNonce = randomNonce();
  url.searchParams.set("nonce", await sha256Hex(rawNonce));

  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: url.href,
      interactive: true,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    if (/only one web auth flow/i.test(msg)) {
      throw new Error(
        "이미 열린 Google 로그인 창이 있습니다. 그 창에서 로그인을 끝내거나 창을 닫은 뒤 다시 시도하세요.",
      );
    }
    if (/did not approve|user cancel/i.test(msg)) {
      throw new Error("로그인이 취소되었습니다");
    }
    if (/could not be loaded/i.test(msg) || /Authorization page/i.test(msg)) {
      throw new Error(
        `로그인 창을 열 수 없습니다. Google Cloud Redirect URI에 추가했는지 확인하세요: ${redirectUri}`,
      );
    }
    throw new Error(msg);
  }

  if (!responseUrl) throw new Error("로그인이 취소되었습니다");

  const redirected = new URL(responseUrl);
  const params = new URLSearchParams(redirected.hash.replace(/^#/, ""));
  const idToken = params.get("id_token");
  if (!idToken) {
    const err = params.get("error") || params.get("error_description");
    throw new Error(err || "Google id_token을 받지 못했습니다");
  }

  const json = await exchangeGoogleIdToken(idToken, rawNonce);
  const session = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in || 3600) * 1000,
    user: json.user || (await fetchUser(json.access_token)),
  };
  await setSession(session);
  return session;
}

export async function signOut() {
  const session = await getSession();
  if (session?.access_token) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_ANON_KEY,
        },
      });
    } catch {
      // ignore
    }
  }
  await clearSession();
}
