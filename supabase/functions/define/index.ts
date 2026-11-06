import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { requireUser, consumeQuota } from "../_shared/auth.ts";
import { geminiJson } from "../_shared/gemini.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const auth = await requireUser(req);
    if ("error" in auth) return jsonResponse({ error: auth.error }, auth.status);

    const body = await req.json();
    const level = String(body.level || "B2");
    const selection = String(body.selection || "").trim().slice(0, 200);
    const text = String(body.text || "").trim().slice(0, 2500);
    if (!selection) return jsonResponse({ error: "selection required" }, 400);

    const quota = await consumeQuota(auth.user.id, 1);
    if (!quota.ok) {
      return jsonResponse(
        {
          error: "Daily quota exceeded",
          remaining: quota.remaining,
          limit: quota.limit,
        },
        429,
      );
    }

    const prompt = `You help a CEFR ${level} Korean learner.
Give ONE short contextual Korean meaning for the selected English expression as used in the paragraph.
Return JSON only: {"surface":"${selection.replace(/"/g, '\\"')}","meaning":"한국어 뜻"}

Selection: ${selection}
Paragraph: ${text}`;

    const parsed = await geminiJson(prompt, "define") as { surface?: string; meaning?: string };
    return jsonResponse({
      surface: parsed.surface || selection,
      meaning: parsed.meaning || "",
      remaining: quota.remaining,
    });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Server error" }, 500);
  }
});
