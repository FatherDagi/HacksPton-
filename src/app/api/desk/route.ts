// Read-only proxy to the station desk (station-desk/, a separate Python service).
// On Vercel, STATION_DESK_URL is injected by the service binding (internal URL).
// Locally, fall back to the uvicorn desk on :8787.
import { NextResponse } from "next/server";

function deskBase(): string {
  // DESK_PUBLIC_URL: the desk running on the laptop that takes the real phone calls, reached through its
  // Cloudflare tunnel. Set it on Vercel so onscene.work sees those calls (Vercel's own copy of the desk
  // can't take Twilio audio streams). Otherwise the Vercel service binding, else the local desk.
  // Read at runtime, never baked in at build time.
  const raw = process.env.DESK_PUBLIC_URL || process.env.STATION_DESK_URL || "http://127.0.0.1:8787";
  return raw.replace(/\/+$/, "");
}

/** The desk only answers tunnel requests that carry this shared secret (see station-desk main.py). */
function deskHeaders(): HeadersInit {
  const token = process.env.DESK_READ_TOKEN?.trim();
  return token ? { "x-desk-token": token } : {};
}

interface DeskLine { t: string | number; speaker: string; text: string }
interface DeskCall {
  id: string;
  status: string;
  started_at: string | number;
  ended_at: string | number | null;
  source: string;
  from_number?: string | null;
  answered?: boolean;
  transcript: DeskLine[];
  partial: { speaker: string; text: string } | null;
  caller_language?: string;
  keywords?: string[];
  card?: { location?: string | null; call_type?: string; summary?: string } | null;
}

/** Desk times are ISO strings (UTC); accept epoch numbers too. Returns ms since epoch. */
const ms = (v: string | number | null | undefined) => (v == null ? null : typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v) || null);

export async function GET() {
  try {
    const res = await fetch(new URL("/api/snapshot", `${deskBase()}/`), {
      cache: "no-store",
      headers: deskHeaders(),
      signal: AbortSignal.timeout(4000), // through the tunnel from Vercel can take a moment
    });
    if (!res.ok) return NextResponse.json({ ok: false, reason: `desk returned ${res.status}` });
    const snap = (await res.json()) as { calls?: DeskCall[] };
    const calls = (snap.calls ?? []).slice(0, 10).map((c) => ({
      id: String(c.id),
      status: String(c.status),
      startedAt: ms(c.started_at) ?? 0,
      endedAt: ms(c.ended_at),
      source: String(c.source ?? ""),
      from: c.from_number ? String(c.from_number).slice(0, 40) : null,
      answered: c.answered === true,
      callerLanguage: c.caller_language ?? null,
      transcript: (c.transcript ?? []).slice(-200).map((l) => ({ t: ms(l.t) ?? 0, speaker: String(l.speaker), text: String(l.text).slice(0, 2000) })),
      partial: c.partial?.text ? { speaker: String(c.partial.speaker), text: String(c.partial.text).slice(0, 2000) } : null,
      location: c.card?.location ?? null,
      callType: c.card?.call_type ?? null,
    }));
    return NextResponse.json({ ok: true, calls });
  } catch {
    return NextResponse.json({ ok: false, reason: "station desk not reachable" });
  }
}
