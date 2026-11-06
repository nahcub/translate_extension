import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
} from "npm:jose@6.2.11";

type AuthOk = { user: { id: string; email?: string } };
type AuthErr = { error: string; status: 401 };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

// Module scope: the key set is fetched once per function instance and cached
// by jose (re-fetched on unknown `kid`, i.e. after key rotation), so the hot
// path is a local signature check with no network round trip.
const JWKS = createRemoteJWKSet(
  new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
  { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 },
);

// jose error codes that mean "this token is bad" (reject) as opposed to
// "we could not check it right now" (fall back to the Auth server).
const REJECT_CODES = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWS_INVALID",
  "ERR_JWT_INVALID",
  "ERR_JOSE_ALG_NOT_ALLOWED",
]);

function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Slow path: ask the Auth server. This also rejects tokens whose session was
// ended by logout, which the local check cannot see.
async function verifyWithAuthServer(token: string): Promise<AuthOk | AuthErr> {
  const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { error: "Unauthorized", status: 401 };
  return { user: { id: data.user.id, email: data.user.email ?? undefined } };
}

/**
 * Authenticates the caller from the access token.
 *
 * Fast path: verify the JWT signature locally against the project's JWKS
 * (asymmetric signing keys). Trade-off: a token stays usable until it expires
 * even after logout or a ban, because nothing asks the Auth server. Keep the
 * JWT expiry short (Auth settings) and the usage quota on to bound that.
 *
 * Falls back to the Auth server for legacy HS256 tokens (no public key to
 * verify with) and when the key set cannot be fetched.
 */
export async function requireUser(req: Request): Promise<AuthOk | AuthErr> {
  const token = bearer(req);
  if (!token) return { error: "Missing Authorization", status: 401 };

  let alg = "";
  try {
    alg = String(decodeProtectedHeader(token).alg || "");
  } catch {
    return { error: "Unauthorized", status: 401 };
  }
  if (alg.startsWith("HS")) return verifyWithAuthServer(token);

  try {
    const { payload } = await jwtVerify(token, JWKS, { audience: "authenticated" });
    // The anon/publishable key is also a valid project JWT; only real users
    // (role "authenticated" with a subject) may call these functions.
    if (payload.role !== "authenticated" || typeof payload.sub !== "string" || !payload.sub) {
      return { error: "Unauthorized", status: 401 };
    }
    const email = typeof payload.email === "string" ? payload.email : undefined;
    return { user: { id: payload.sub, email } };
  } catch (err) {
    const code = (err as { code?: string })?.code || "";
    if (REJECT_CODES.has(code)) return { error: "Unauthorized", status: 401 };
    console.warn("local JWT verification unavailable, using Auth server", code || String(err));
    return verifyWithAuthServer(token);
  }
}

// Daily paragraph cap is off. The call sites stay so it can be turned back on later.
export async function consumeQuota(_userId: string, _amount: number) {
  return { ok: true as const, remaining: null, limit: null };
}
