# Pitch, demo and Devpost plan

Built from research on how hackathons are judged (MLH judging guide, judges' and winners' write-ups, past winning dispatch projects). Full notes are in our research folder.

## What judges actually do

- Each judge spends about **4 minutes** with us: about 2 min presentation and demo, 1 min questions, then they move on. At least 3 judges see us; winners are ranked.
- **The first 30 seconds set the score.** Show the product early; no long background.
- **One complete path beats four half-built ones.** Demo only what works end to end.
- **The core must be real; supporting data can be simulated if we say so.** Our core: call → sheet fills → priority → officers proposed → dispatcher approves → officers move. Officer GPS is simulated and labelled on screen.
- **Never say the AI decides or dispatches.** Say it *drafts, recommends and explains*; a human approves every dispatch.
- **Name a weakness before they ask** (it raised scores in judges' notes). Ours: officer positions are simulated today; next is the officer phone app.

## We are not the first dispatch idea, so lead with what's different

Similar projects have won before (DispatchAI, Berkeley 2024; FirstWave AI, United Hacks; OperatorAI). Our differences, in this order:

1. **Built with Princeton Public Safety**: real dispatch centre, real campus, the Google Sheets they use today (Peri evidence).
2. **Explains itself**: every priority quotes the caller's words; the AI and dispatcher log is an audit trail.
3. **Re-plans live**: the caller says "tire iron", and the AI upgrades P2 → P1 and adds a third officer, on screen.
4. **Sends the right number of officers**: 2 for a weapon, 1 for a bike theft or lockout, ranked by real arrival time on real roads and footpaths.
5. **Sees the campus**: 2025 satellite, 2020 leaf-off state imagery, 3D buildings, the caller's building outlined.

## 2-minute script

| Time | Say / do |
|---|---|
| 0:00–0:15 | **Hook.** "Nearly half of 68 big-city 911 centres missed the 15-second answer standard last year, and at Princeton one dispatcher handles a call alone while typing notes." *(Use our PSAFE quote here if we get one.)* |
| 0:15–0:25 | **What it is.** "Dispatch Copilot listens beside the dispatcher, fills the sheet, and recommends who to send. The dispatcher always decides." |
| 0:25–1:25 | **Live demo, P1 Knife fight.** Point at the sheet filled from the call and the "still need to ask" list → priority with the quote → "2 officers, never one alone" → press **Y** → officers drive the real route, ETA counts down. Then **P2 Bike crash**, press **E**: the caller mentions a tire iron, the stripe flashes, P2 → P1, 3 officers. |
| 1:25–1:40 | **Why trust it.** Point at the log: every AI step quoted, every dispatcher override recorded. Human approves every dispatch. |
| 1:40–1:55 | **Tech + tracks.** Gemini (listening and structured sheet), real routing, map and imagery; Houston building with CoStar + Matterport + Vexcel. |
| 1:55–2:00 | **Close.** "Built with PSAFE. Ready to pilot on their next shift." Stop talking. |

## Demo safety

- Record a **60–90 s backup video** of the exact demo before judging; switch to it calmly if anything fails.
- Bring a phone hotspot. The map, imagery and routing are online services.
- Keep the console as the **front browser tab** (browsers pause maps in background tabs).
- Shortcuts: **Y** send, **N** skip, **E** caller adds new info, **1–4** override priority.

## Per-track emphasis

- **Healthcare (main):** time-critical care, with the cardiac arrest and inside-the-building delay stats.
- **CoStar (30% data, 30% agentic):** Houston building with all three data layers; show the AI's plan steps in the log.
- **Amazon:** a working prototype, a clear user (the PSAFE dispatcher), this README and the pitch.
- **Peri:** business name, the person consulted and their role, plus a photo, screenshot or quote. Show one change we made because of them.
- **Gemini (MLH):** live audio to a structured incident sheet; a Spanish-speaking caller would be a strong extra.

## Devpost

- **Logline:** "For campus dispatchers, Dispatch Copilot turns a live emergency call into a filled incident sheet and a ranked officer recommendation, so the right number of officers reach the right building faster, with a human approving every dispatch."
- Sections: Inspiration (PSAFE visit) · What it does · How we built it · Challenges · Accomplishments · What's next (officer phone app, real GPS, Houston pilot).
- Add screenshots/GIF, everyone's Discord username, and the public video link. **Deadline: 8:00 AM Sunday.** Start the write-up Saturday evening.
