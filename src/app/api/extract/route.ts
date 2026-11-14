// Server-side Gemini extraction. The API key never leaves the server.
import { GoogleGenAI } from "@google/genai";
import { FIELD_LABELS } from "@/lib/fields";
import { ExtractRequest, GeminiExtraction, GEMINI_RESPONSE_SCHEMA, type ExtractError, type ExtractResponse } from "@/lib/extraction";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const SYSTEM = `You help a campus emergency dispatcher by extracting facts from a SIMULATED emergency call transcript.
Rules:
- Only extract information the caller or dispatcher actually said. Never guess, infer diagnoses, or invent details.
- If something is not stated, do not include that field; list it in missingFields instead.
- Keep values short (a few words), in plain language.
- evidenceSegmentId must be the id of the transcript segment that supports the value.
- Do not contradict values listed as already confirmed by the dispatcher; do not repeat them.
- suggestedQuestions: up to 4 short follow-up questions, most important first, for information still missing.
Field keys and meanings:
${Object.entries(FIELD_LABELS).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`;

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
  try {
    const ai = new GoogleGenAI({ apiKey });
    const interaction = await ai.interactions.create({
      model: MODEL,
      system_instruction: SYSTEM,
      input,
      response_format: { type: "text", mime_type: "application/json", schema: GEMINI_RESPONSE_SCHEMA },
      store: false,
    });
    raw = (interaction as { output_text?: string }).output_text;
  } catch (err) {
    // Log without echoing secrets.
    console.error("[extract] Gemini request failed:", err instanceof Error ? err.message.slice(0, 300) : "unknown error");
    return json({ ok: false, error: "upstream_error", message: "Gemini request failed." }, 502);
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
    model: MODEL,
    updates,
    missingFields: parsed.missingFields,
    suggestedQuestions: parsed.suggestedQuestions,
  });
}

export async function GET() {
  return Response.json({ geminiConfigured: !!process.env.GEMINI_API_KEY, model: MODEL });
}
