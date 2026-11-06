const MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash";

// Thinking tokens are generated one by one before the answer, like normal
// output, so they add directly to latency. "minimal" is the fastest level.
// If the model rejects it, fall back to "low" once and remember that for the
// lifetime of this function instance.
const PREFERRED_THINKING = Deno.env.get("GEMINI_THINKING_LEVEL") || "minimal";
const FALLBACK_THINKING = "low";
let thinkingLevel = PREFERRED_THINKING;

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Models sometimes wrap JSON in ```json fences even with responseMimeType.
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1].trim());
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Gemini returned non-JSON text");
  }
}

async function callGemini(url: string, prompt: string, level: string) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: level },
      },
    }),
  });
}

export async function geminiJson(prompt: string, label = "gemini"): Promise<unknown> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY is not set");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent` +
    `?key=${encodeURIComponent(key)}`;

  const started = Date.now();
  let res = await callGemini(url, prompt, thinkingLevel);

  if (!res.ok && res.status === 400 && thinkingLevel !== FALLBACK_THINKING) {
    const text = await res.text();
    if (/thinking/i.test(text)) {
      console.warn(`thinkingLevel "${thinkingLevel}" rejected, falling back to "${FALLBACK_THINKING}"`);
      thinkingLevel = FALLBACK_THINKING;
      res = await callGemini(url, prompt, thinkingLevel);
    } else {
      throw new Error(`Gemini error ${res.status}: ${text.slice(0, 400)}`);
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini error ${res.status}: ${text.slice(0, 400)}`);
  }

  const data = await res.json();

  // One line per call so latency and token usage can be compared before/after
  // changes in the Supabase function logs.
  const usage = data?.usageMetadata || {};
  console.log(JSON.stringify({
    metric: "gemini_call",
    label,
    model: MODEL,
    thinkingLevel,
    ms: Date.now() - started,
    promptTokens: usage.promptTokenCount ?? null,
    outputTokens: usage.candidatesTokenCount ?? null,
    thoughtsTokens: usage.thoughtsTokenCount ?? null,
  }));

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.filter((p: { thought?: boolean }) => !p.thought)
      ?.map((p: { text?: string }) => p.text || "")
      .join("") || "";
  if (!text) {
    const block = data?.candidates?.[0]?.finishReason || data?.promptFeedback;
    throw new Error(`Empty Gemini response (${JSON.stringify(block)})`);
  }
  return extractJson(text);
}
