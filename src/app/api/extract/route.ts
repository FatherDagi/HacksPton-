// Server-side Gemini extraction. The API key never leaves the server.
import { GoogleGenAI } from "@google/genai";
import { FIELD_LABELS } from "@/lib/fields";
import { ExtractRequest, GeminiExtraction, GEMINI_RESPONSE_SCHEMA, type ExtractError, type ExtractResponse } from "@/lib/extraction";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
// Tried in order when the preferred model is overloaded or unavailable.
// Lite models are much less congested during busy periods and fast enough for extraction.
const FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"];
const PRIMARY_TIMEOUT_MS = 3_500; // notes must keep up with the call; a slow model falls back fast
/** Model -> time (ms) before which we don't try it again after a quota error. */
const coolDown = new Map<string, number>();

// Standard call-taking items that need a little guidance to fill well.
const FIELD_HINTS: Partial<Record<string, string>> = {
  callback: "phone number to call the caller back",
  incident_time: "when it happened, e.g. 'just now', '10 minutes ago', 'ongoing'",
  condition: "injuries or what is wrong with the patient/victim",
  patient_info: "patient age and sex if said, e.g. 'about 20, male'",
  suspect: "suspect description: clothing, build, hair, name if known",
  direction: "which way the suspect left, e.g. 'toward Nassau St on foot'",
  vehicle: "vehicle color, make, model, plate",
  hazards: "fire, smoke, chemicals, downed lines, anything dangerous to responders",
  access: "best entrance or how responders get in",
};
const FALLBACK_TIMEOUT_MS = 12_000;

const SYSTEM = `You help a campus emergency dispatcher by extracting facts from a SIMULATED emergency call transcript.
Rules:
- Only extract information the caller or dispatcher actually said. Never guess, infer diagnoses, or invent details.
- If something is not stated, do not include that field; list it in missingFields instead.
- Keep values short (a few words), in plain language.
- evidenceSegmentId must be the id of the transcript segment that supports the value.
- Do not contradict values listed as already confirmed by the dispatcher; do not repeat them.
- suggestedQuestions: up to 4 short follow-up questions, most important first, for information still missing.
- Fill fields as soon as the call mentions them; update a value when the caller gives a newer or more exact answer.
Field keys and meanings:
${Object.entries(FIELD_LABELS).map(([k, v]) => `- ${k}: ${v}${FIELD_HINTS[k] ? ` (${FIELD_HINTS[k]})` : ""}`).join("\n")}`;

function json(body: ExtractResponse | ExtractError, status = 200) {
  return Response.json(body, { status });
}

export async function POST(req: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ ok: false, error: "not_configured", message: "GEMINI_API_KEY is not set on the server." }, 503);
  }

  let body: ExtractRequest;
  try {
    body = ExtractRequest.parse(await req.json());
  } catch {
    return json({ ok: false, error: "bad_request", message: "Invalid request body." }, 400);
  }

  const transcriptText = body.transcript.map((s) => `[${s.id}] ${s.speaker.toUpperCase()}: ${s.text}`).join("\n");
  const confirmedText = Object.entries(body.confirmed).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "(none)";
  const input = `Incident category: ${body.category}
Already confirmed by dispatcher:
${confirmedText}

Transcript so far:
${transcriptText}`;

  let raw: string | undefined;
  let usedModel = MODEL;
  const ai = new GoogleGenAI({ apiKey });
  // Skip a model that just said it's over quota (429) until its cool-down passes, instead of
  // spending a round trip on it every time the critical notes refresh.
  const models = [MODEL, ...FALLBACK_MODELS.filter((m) => m !== MODEL)].filter((m) => (coolDown.get(m) ?? 0) < Date.now());
  if (models.length === 0) models.push(FALLBACK_MODELS[0]);
  for (const model of models) {
    try {
      const interaction = await ai.interactions.create(
        {
          model,
          system_instruction: SYSTEM,
          input,
          response_format: { type: "text", mime_type: "application/json", schema: GEMINI_RESPONSE_SCHEMA },
          store: false,
        },
        // Fail fast instead of the SDK's long default retry loop; we fall back to the next model.
        { timeout: model === MODEL ? PRIMARY_TIMEOUT_MS : FALLBACK_TIMEOUT_MS, maxRetries: 0 },
      );
      raw = (interaction as { output_text?: string }).output_text;
      usedModel = model;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (/\b429\b|rate limit|quota/i.test(msg)) {
        // "Please retry in 4h53m" / "retry in 32.6s": honour it, capped at 10 minutes so we re-check.
        const m = msg.match(/retry in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
        const secs = m ? (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) : 60;
        coolDown.set(model, Date.now() + Math.min(Math.max(secs, 30), 600) * 1000);
      } else if (/\b503\b|high demand|overloaded|unavailable|timed out|timeout|aborted/i.test(msg)) {
        // Overloaded or too slow right now: skip it for 2 minutes and use the next model straight away,
        // instead of waiting out a timeout on every single update.
        coolDown.set(model, Date.now() + 120_000);
      }
      // Log without echoing secrets.
      console.error(`[extract] ${model} failed:`, err instanceof Error ? err.message.replace(/AQ\.[\w-]+|AIza[\w-]+/g, "[key]").slice(0, 200) : "unknown error");
    }
  }
  if (raw === undefined) {
    return json({ ok: false, error: "upstream_error", message: "Gemini is unavailable right now." }, 502);
  }

  let parsed: GeminiExtraction;
  try {
    parsed = GeminiExtraction.parse(JSON.parse(raw ?? ""));
  } catch {
    console.error("[extract] Gemini returned output that failed validation.");
    return json({ ok: false, error: "invalid_output", message: "Gemini output failed validation." }, 502);
  }

  const segIds = new Set(body.transcript.map((s) => s.id));
  const updates = parsed.fields
    .filter((f) => !(f.key in body.confirmed))
    .map((f) => ({
      key: f.key,
      value: f.value.trim(),
      status: "unverified" as const, // only the dispatcher can confirm
      evidenceSegmentId: segIds.has(f.evidenceSegmentId) ? f.evidenceSegmentId : null,
    }));

  return json({
    ok: true,
    model: usedModel,
    updates,
    missingFields: parsed.missingFields,
    suggestedQuestions: parsed.suggestedQuestions,
  });
}

export async function GET() {
  return Response.json({ geminiConfigured: !!process.env.GEMINI_API_KEY, model: MODEL });
}
