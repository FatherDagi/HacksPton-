// Helpers that turn station-desk call data into console incident data.
import { BUILDINGS } from "./campus";
import type { IncidentCategory, TranscriptSegment } from "./types";

export interface DeskLine { t: number; speaker: string; text: string }
export interface DeskCall {
  id: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  source: string;
  callerLanguage: string | null;
  transcript: DeskLine[];
  partial: { speaker: string; text: string } | null;
  location: string | null;
  callType: string | null;
}

/** Words a caller is likely to use for each campus building we can place on the map. */
const ALIASES: Record<string, string[]> = {
  frist: ["frist", "campus center"],
  nassau: ["nassau hall"],
  firestone: ["firestone"],
  whitman: ["whitman"],
  equad: ["e quad", "equad", "engineering quad", "engineering quadrangle", "olden street"],
  stadium: ["stadium", "princeton stadium"],
  jadwin: ["jadwin"],
  dillon: ["dillon"],
  dps: ["public safety"],
  lewis: ["lewis library"],
};

/** Lower-case, hyphens/punctuation to spaces, single spaces: "E-Quad" and "E quad" compare equal. */
const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/** First campus building mentioned in the text, or null. */
export function matchBuilding(text: string): string | null {
  const t = norm(text);
  let best: { id: string; at: number } | null = null;
  for (const b of BUILDINGS) {
    for (const a of ALIASES[b.id] ?? [b.name]) {
      const at = t.indexOf(norm(a));
      if (at >= 0 && (!best || at < best.at)) best = { id: b.id, at };
    }
  }
  return best?.id ?? null;
}

/** Category implied by extracted/desk text, or null when unclear. */
export function categoryFrom(text: string): IncidentCategory | null {
  const t = text.toLowerCase();
  if (/\b(fire|smoke|burning|flames?|alarm)\b/.test(t)) return "fire";
  if (/\b(medical|ems|ambulance|collapsed?|unconscious|not breathing|seizure|overdose|bleeding|injur)/.test(t)) return "medical";
  if (/\b(police|fight|assault|knife|gun|weapon|theft|stolen|robbery|intruder|suspicious|security|threat)/.test(t)) return "police";
  return null;
}

export const deskSpeaker = (s: string): "caller" | "dispatcher" => (/caller/i.test(s) ? "caller" : "dispatcher");

/**
 * The desk stores speech as short fragments ("Hi, I need" / "help."). Join consecutive fragments
 * from the same speaker into sentences: break on . ? !, a speaker change, or a pause over 2.5 s.
 * Segment ids use the first fragment's index, so they stay stable as a sentence grows.
 */
export function groupDeskLines(call: DeskCall): { segments: TranscriptSegment[]; finishedCallerSentences: number } {
  const segments: TranscriptSegment[] = [];
  let lastT = 0;
  call.transcript.forEach((l, i) => {
    const speaker = deskSpeaker(l.speaker);
    const prev = segments[segments.length - 1];
    const joinable = prev && prev.speaker === speaker && !/[.?!]["')\]]?$/.test(prev.text) && l.t - lastT <= 2500;
    if (joinable) prev.text = `${prev.text} ${l.text}`.replace(/\s+/g, " ");
    else segments.push({ id: `desk-${call.id}-${i}`, t: Math.max(0, Math.round((l.t - call.startedAt) / 1000)), speaker, text: l.text });
    lastT = l.t;
  });
  const finishedCallerSentences = segments.filter((s, i) => s.speaker === "caller" && (i < segments.length - 1 || /[.?!]["')\]]?$/.test(s.text))).length;
  return { segments, finishedCallerSentences };
}
