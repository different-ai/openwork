/**
 * Internal proof: Google Calendar capability routes support creating and adding
 * Meet links without launching Electron. Evidence is source and test snippets.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "calendar-meet-link";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROUTE_SOURCE_PATH = join(ROOT, "ee", "apps", "den-api", "src", "routes", "org", "google-workspace.ts");
const EXTRACTOR_SOURCE_PATH = join(ROOT, "ee", "apps", "den-api", "src", "capability-sources", "google-workspace-api.ts");
const TEST_SOURCE_PATH = join(ROOT, "ee", "apps", "den-api", "test", "google-workspace-capabilities.test.ts");

// Narration is loaded from the approved script (evals/voiceovers/calendar-meet-link.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("calendar-meet-link");

function witness(ctx, condition, assertion, actual = "") {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, actual ? `${assertion} (actual: ${actual})` : assertion);
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

function numberedSnippet(source, anchor, lineCount) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.includes(anchor));
  if (start === -1) return `Missing snippet anchor: ${anchor}`;
  return lines
    .slice(start, start + lineCount)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join("\n");
}

function hasPattern(source, pattern) {
  return pattern.test(source);
}

async function readProofSources() {
  const [routeSource, extractorSource, testSource] = await Promise.all([
    readFile(ROUTE_SOURCE_PATH, "utf8"),
    readFile(EXTRACTOR_SOURCE_PATH, "utf8"),
    readFile(TEST_SOURCE_PATH, "utf8"),
  ]);
  return { routeSource, extractorSource, testSource };
}

export default {
  id: FLOW_ID,
  title: "Google Calendar capability can create events with Meet links and add Meet links to existing events",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "The create-event API schema accepts createMeetLink",
      run: async (ctx) => {
        await ctx.prove("POST /v1/capabilities/google-workspace/calendar-events exposes createMeetLink in the request body and meetLink in the response", {
          voiceover: vo[0],
          assert: async () => {
            const { routeSource } = await readProofSources();
            witness(ctx, routeSource.includes("createMeetLink: z.boolean().optional()"), "Create body schema accepts optional createMeetLink");
            witness(ctx, routeSource.includes("the response returns meetLink when Google creates it"), "Create body schema explains meetLink is returned");
            witness(ctx, hasPattern(routeSource, /app\.post\(\s*"\/v1\/capabilities\/google-workspace\/calendar-events"/), "POST calendar-events route exists");
            witness(ctx, routeSource.includes("jsonValidator(createCalendarEventBodySchema)"), "POST route validates the createCalendarEventBodySchema request body");
            witness(ctx, routeSource.includes("Set createMeetLink to true to request a Google Meet conferencing link and return meetLink"), "OpenAPI route description documents createMeetLink and meetLink");
            witness(ctx, routeSource.includes("meetLink: z.string().nullable()"), "Calendar event responses include meetLink");
            ctx.output("source: create schema + POST route", [
              numberedSnippet(routeSource, "const createCalendarEventBodySchema", 20),
              numberedSnippet(routeSource, "  app.post(", 18),
            ].join("\n\n"));
          },
        });
      },
    },
    {
      name: "The create-event test exercises a Meet-enabled event",
      run: async (ctx) => {
        await ctx.prove("The backend test covers title, attendee, time, conferenceDataVersion=1, conferenceData.createRequest, and the returned Meet link", {
          voiceover: vo[1],
          assert: async () => {
            const { routeSource, testSource } = await readProofSources();
            witness(ctx, testSource.includes("calendar create requests a Google Meet link when asked"), "Targeted test names the create+Meet behavior");
            witness(ctx, testSource.includes('method: "POST"'), "Test calls the capability with POST");
            witness(ctx, testSource.includes('summary: "Planning call"'), "Test supplies the expected event title");
            witness(ctx, testSource.includes('start: "2026-07-08T12:00:00Z"') && testSource.includes('end: "2026-07-08T12:30:00Z"'), "Test supplies the expected start and end time");
            witness(ctx, testSource.includes('attendees: ["ada@example.com"]'), "Test supplies the expected attendee");
            witness(ctx, testSource.includes("createMeetLink: true"), "Test asks for a Meet link");
            witness(ctx, testSource.includes('expect(url.searchParams.get("conferenceDataVersion")).toBe("1")'), "Test verifies conferenceDataVersion=1 reaches Google");
            witness(ctx, testSource.includes("expectRecord(conferenceData.createRequest"), "Test verifies conferenceData.createRequest is sent");
            witness(ctx, testSource.includes('expect(solutionKey.type).toBe("hangoutsMeet")'), "Test verifies Google Meet is requested as hangoutsMeet");
            witness(ctx, testSource.includes('meetLink: "https://meet.google.com/created-meet"'), "Test verifies the create response returns meetLink");
            witness(ctx, routeSource.includes('url.searchParams.set("conferenceDataVersion", "1")'), "Create implementation sets conferenceDataVersion=1 when createMeetLink is true");
            witness(ctx, routeSource.includes("eventPayload.conferenceData = buildCalendarConferenceData()"), "Create implementation attaches conferenceData.createRequest when createMeetLink is true");
            witness(ctx, routeSource.includes("const payload: CalendarEventCreatePayload = { summary: input.summary, start, end }"), "Create implementation maps the requested title and times into the Google payload");
            witness(ctx, routeSource.includes("payload.attendees = input.attendees.map((email) => ({ email }))"), "Create implementation maps attendee emails into the Google payload");
            ctx.output("test: calendar create requests a Google Meet link", numberedSnippet(testSource, "test(\"calendar create requests a Google Meet link when asked\"", 44));
            ctx.output("source: create path adds conferenceData", [
              numberedSnippet(routeSource, "function buildCalendarEventPayload", 16),
              numberedSnippet(routeSource, "function buildCalendarConferenceData", 9),
              numberedSnippet(routeSource, "      if (input.createMeetLink)", 14),
            ].join("\n\n"));
          },
        });
      },
    },
    {
      name: "The patch route adds Meet to the existing event",
      run: async (ctx) => {
        await ctx.prove("PATCH /v1/capabilities/google-workspace/calendar-event/:eventId uses Google PATCH and the test proves it does not create a duplicate", {
          voiceover: vo[2],
          assert: async () => {
            const { routeSource, testSource } = await readProofSources();
            witness(ctx, hasPattern(routeSource, /app\.patch\(\s*"\/v1\/capabilities\/google-workspace\/calendar-event\/:eventId"/), "PATCH calendar-event/:eventId route exists");
            witness(ctx, routeSource.includes("without creating a duplicate"), "Route description states the existing-event/no-duplicate intent");
            witness(ctx, routeSource.includes("events/${encodeURIComponent(eventId)}"), "Route targets the existing Google event id");
            witness(ctx, routeSource.includes('method: "PATCH"'), "Route sends PATCH to Google Calendar");
            witness(ctx, routeSource.includes("body: JSON.stringify({ conferenceData: buildCalendarConferenceData() })"), "Route only patches conferenceData for the existing event");
            witness(ctx, testSource.includes("calendar patch adds a Google Meet link without creating a duplicate"), "Targeted test names patch+Meet without duplicate behavior");
            witness(ctx, testSource.includes('expect(lastCalendarMethod).toBe("PATCH")'), "Test verifies Google saw PATCH");
            witness(ctx, testSource.includes("expect(calendarCreateCount).toBe(0)"), "Test verifies no create call happened during patch");
            witness(ctx, testSource.includes('expect(url.pathname).toBe("/calendar/v3/calendars/primary/events/existing_event_1")'), "Test verifies the existing event path is patched");
            ctx.output("source: PATCH route", numberedSnippet(routeSource, "  app.patch(", 45));
            ctx.output("test: patch adds Meet without duplicate", numberedSnippet(testSource, "test(\"calendar patch adds a Google Meet link without creating a duplicate\"", 37));
          },
        });
      },
    },
    {
      name: "Meet links are extracted from create and update responses",
      run: async (ctx) => {
        await ctx.prove("The response mapper returns meetLink from hangoutLink or a video entryPoint, and PATCH returns that meetLink to the caller", {
          voiceover: vo[3],
          assert: async () => {
            const { routeSource, extractorSource, testSource } = await readProofSources();
            witness(ctx, extractorSource.includes('const hangoutLink = readString(event, "hangoutLink")'), "Extractor reads Google hangoutLink");
            witness(ctx, extractorSource.includes("if (hangoutLink) return hangoutLink"), "Extractor returns hangoutLink when present");
            witness(ctx, extractorSource.includes('readArray(conferenceData, "entryPoints")'), "Extractor scans conferenceData entryPoints");
            witness(ctx, extractorSource.includes('readString(entryPoint, "entryPointType") !== "video"'), "Extractor filters entryPoints to video links");
            witness(ctx, extractorSource.includes('const uri = readString(entryPoint, "uri")'), "Extractor reads the video entryPoint URI");
            witness(ctx, hasPattern(routeSource, /app\.patch\([\s\S]*?return c\.json\(\{[\s\S]*?eventId: event\.id,[\s\S]*?meetLink: event\.meetLink,[\s\S]*?\}\)/), "PATCH response returns meetLink from the extracted event");
            witness(ctx, testSource.includes('hangoutLink: "https://meet.google.com/created-meet"'), "Create fixture receives Meet from hangoutLink");
            witness(ctx, testSource.includes('meetLink: "https://meet.google.com/created-meet"'), "Create response assertion exposes hangoutLink as meetLink");
            witness(ctx, testSource.includes('entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/updated-meet" }]'), "Update fixture receives Meet from a video entryPoint");
            witness(ctx, testSource.includes('meetLink: "https://meet.google.com/updated-meet"'), "Patch response assertion exposes the video entryPoint as meetLink");
            ctx.output("source: Meet link extractor", numberedSnippet(extractorSource, "function calendarEventMeetLink", 18));
            ctx.output("source: PATCH response includes meetLink", numberedSnippet(routeSource, "Google Calendar event update", 18));
            ctx.output("test: hangoutLink and video entryPoint fixtures", [
              numberedSnippet(testSource, 'hangoutLink: "https://meet.google.com/created-meet"', 8),
              numberedSnippet(testSource, 'entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/updated-meet" }]', 8),
              numberedSnippet(testSource, 'meetLink: "https://meet.google.com/updated-meet"', 4),
            ].join("\n\n"));
          },
        });
      },
    },
  ],
};
