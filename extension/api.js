import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { refreshSessionIfNeeded } from "./auth.js";

async function authHeaders() {
  const session = await refreshSessionIfNeeded();
  if (!session?.access_token) {
    const err = new Error("로그인이 필요합니다");
    err.code = "NOT_SIGNED_IN";
    throw err;
  }
  return {
    Authorization: `Bearer ${session.access_token}`,
    apikey: SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
  };
}

async function callFunction(name, body) {
  const headers = await authHeaders();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text };
  }

  if (res.status === 429) {
    const err = new Error("오늘 사용량을 모두 사용했습니다");
    err.code = "QUOTA_EXCEEDED";
    throw err;
  }
  if (!res.ok) {
    const err = new Error(json?.error || `API 오류 (${res.status})`);
    err.code = "API_ERROR";
    err.status = res.status;
    throw err;
  }
  return json;
}

export async function annotate({ level, paragraphs }) {
  return callFunction("annotate", { level, paragraphs });
}

export async function define({ level, text, selection }) {
  return callFunction("define", { level, text, selection });
}
