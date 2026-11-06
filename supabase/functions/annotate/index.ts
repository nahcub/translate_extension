import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { requireUser, consumeQuota } from "../_shared/auth.ts";
import { geminiJson } from "../_shared/gemini.ts";

const MAX_BATCH = 8;
const MAX_CHARS = 2500;

function foldWithMap(paragraph: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < paragraph.length; i++) {
    const ch = paragraph[i];
    if (/\s/.test(ch)) {
      if (prevSpace) continue;
      folded += " ";
      map.push(i);
      prevSpace = true;
    } else {
      folded += ch.toLowerCase();
      map.push(i);
      prevSpace = false;
    }
  }
  return { folded, map };
}

function indexOfFold(paragraph: string, needle: string): { start: number; end: number } | null {
  const n = needle.toLowerCase().replace(/\s+/g, " ").trim();
  if (n.length < 2) return null;
  const { folded, map } = foldWithMap(paragraph);
  const startFold = folded.indexOf(n);
  if (startFold < 0) return null;
  const endFold = startFold + n.length - 1;
  return { start: map[startFold], end: map[endFold] + 1 };
}

function alignSurface(paragraph: string, surface: string): string | null {
  const raw = String(surface || "")
    .trim()
    .replace(/^[\s"'`“”‘’*]+|[\s"'`“”‘’*]+$/g, "");
  if (!raw) return null;
  const direct = indexOfFold(paragraph, raw);
  if (direct) return paragraph.slice(direct.start, direct.end);
  const core = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (core.length >= 2 && core !== raw) {
    const hit = indexOfFold(paragraph, core);
    if (hit) return paragraph.slice(hit.start, hit.end);
  }
  return null;
}

function resultList(parsed: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  for (const key of ["results", "paragraphs", "annotations", "items"]) {
    if (Array.isArray(obj[key])) return obj[key] as Array<Record<string, unknown>>;
  }
  return [];
}

function termFields(term: Record<string, unknown>) {
  const surface = term.surface ?? term.word ?? term.term ?? term.phrase ?? term.text ?? "";
  const meaning = term.meaning ?? term.gloss ?? term.translation ?? term.korean ?? term.definition ?? "";
  return { surface: String(surface), meaning: String(meaning) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const auth = await requireUser(req);
    if ("error" in auth) return jsonResponse({ error: auth.error }, auth.status);

    const body = await req.json();
    const level = String(body.level || "B2");
    const paragraphs = Array.isArray(body.paragraphs) ? body.paragraphs : [];
    if (!paragraphs.length) return jsonResponse({ results: [] });
    if (paragraphs.length > MAX_BATCH) {
      return jsonResponse({ error: `Max ${MAX_BATCH} paragraphs per request` }, 400);
    }

    const cleaned = paragraphs.map((p: { id?: string; text?: string }) => ({
      id: String(p.id || ""),
      text: String(p.text || "").slice(0, MAX_CHARS),
    })).filter((p: { id: string; text: string }) => p.id && p.text.trim());

    const quota = await consumeQuota(auth.user.id, cleaned.length);
    if (!quota.ok) {
      return jsonResponse(
        {
          error: "오늘 사용량을 모두 사용했습니다",
          remaining: quota.remaining,
          limit: quota.limit,
        },
        429,
      );
    }

    const prompt = `You help Korean learners read English web pages.
Learner CEFR level: ${level}.
For EACH paragraph, pick 2 to 8 words or short phrases that are likely difficult or nuanced for that level.
Prefer content words (nouns, verbs, adjectives, adverbs, idioms). Skip the most basic function words.
Even for C1/C2, still pick subtle/academic/rare items if present. Only use [] when the paragraph is extremely simple.
Meaning must be short contextual Korean for THIS paragraph (not a long dictionary entry).
Return JSON only, with one results item per paragraph, in the same order.
Copy each paragraph "id" exactly. Do not invent or abbreviate ids.
{"results":[{"id":"<the paragraph id>","terms":[{"surface":"exact substring copied from the paragraph","meaning":"짧은 한국어 뜻"}]}]}
surface MUST be copied exactly from the paragraph text (same spelling and casing).

Paragraphs:
${JSON.stringify(cleaned)}`;

    const parsed = await geminiJson(prompt);
    const list = resultList(parsed);
    const idMatches = list.filter((r) => cleaned.some((p: { id: string }) => String(r.id) === p.id)).length;
    const useIndex = idMatches === 0 && list.length > 0;

    const results = cleaned.map((p: { id: string; text: string }, index: number) => {
      const hit = useIndex
        ? list[index]
        : list.find((r) => String(r.id) === p.id);
      const rawTerms = Array.isArray(hit?.terms)
        ? hit.terms
        : Array.isArray(hit?.words)
        ? hit.words
        : [];
      const terms = (rawTerms as Array<Record<string, unknown>>)
        .map((t) => {
          const fields = termFields(t || {});
          const surface = alignSurface(p.text, fields.surface);
          const meaning = fields.meaning.trim();
          if (!surface || !meaning) return null;
          return { surface, meaning };
        })
        .filter(Boolean)
        .slice(0, 12) as Array<{ surface: string; meaning: string }>;
      return { id: p.id, terms };
    });

    const totalTerms = results.reduce((sum, r) => sum + r.terms.length, 0);
    if (totalTerms === 0) {
      console.warn(
        "annotate produced no terms",
        JSON.stringify(parsed).slice(0, 800),
      );
    }

    return jsonResponse({ results, remaining: quota.remaining });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Server error" }, 500);
  }
});
