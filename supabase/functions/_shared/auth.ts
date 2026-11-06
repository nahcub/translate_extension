import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export function getUserClient(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return { error: "Missing Authorization", status: 401 as const };

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  return { supabase, authHeader };
}

export async function requireUser(req: Request) {
  const client = getUserClient(req);
  if ("error" in client) return client;

  const { data, error } = await client.supabase.auth.getUser();
  if (error || !data.user) {
    return { error: "Unauthorized", status: 401 as const };
  }
  return { user: data.user, supabase: client.supabase };
}

// Daily paragraph cap is off. The call sites stay so it can be turned back on later.
export async function consumeQuota(_userId: string, _amount: number) {
  return { ok: true as const, remaining: null, limit: null };
}
