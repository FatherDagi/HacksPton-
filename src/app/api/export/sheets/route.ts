// Google Sheets export (Phase 6). Until a service account is configured this
// returns a clear "not configured" message instead of pretending to export.
import { z } from "zod";

const Body = z.object({
  incident: z.object({ id: z.string().max(80), number: z.string().max(40) }).passthrough(),
  events: z.array(z.unknown()).max(2000),
  assignments: z.array(z.unknown()).max(50),
});

export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return Response.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }
  const configured =
    !!process.env.GOOGLE_SHEETS_SPREADSHEET_ID && !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && !!process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!configured) {
    return Response.json(
      { ok: false, message: `Not exported: Google Sheets is not configured yet (incident ${body.incident.number}).` },
      { status: 503 },
    );
  }
  return Response.json({ ok: false, message: "Sheets export is pending implementation (Phase 6)." }, { status: 501 });
}
