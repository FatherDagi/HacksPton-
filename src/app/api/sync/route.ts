// Sync hub for the demo: one ordered action log. Every screen posts its actions here and polls for the
// ones it hasn't seen. In memory locally; in Upstash Redis when deployed (see src/lib/syncHub.ts).
import { NextResponse } from "next/server";
import type { Action } from "@/lib/reducer";
import { appendAction, BadAction, readSync } from "@/lib/syncHub";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const after = Number(url.searchParams.get("since") ?? -1);
  try {
    return NextResponse.json(await readSync(after, url.searchParams.get("unit")));
  } catch (e) {
    console.error("sync read failed:", (e as Error).message);
    return NextResponse.json({ error: "sync unavailable" }, { status: 503 });
  }
}

export async function POST(req: Request) {
  const { client, cid, action } = (await req.json()) as { client: string; cid: number; action: Action };
  if (!action || typeof action.type !== "string") return NextResponse.json({ error: "bad action" }, { status: 400 });
  try {
    return NextResponse.json({ seq: await appendAction(client, cid, action) });
  } catch (e) {
    if (e instanceof BadAction) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("sync write failed:", (e as Error).message);
    return NextResponse.json({ error: "sync unavailable" }, { status: 503 });
  }
}
