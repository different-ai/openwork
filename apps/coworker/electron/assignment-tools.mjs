/**
 * The coworker's own tools for its assignments, its memory, and its soul,
 * served on the same loopback MCP server as its document and Worker tools
 * (`coworker-tools.mjs`). Handlers take the coworker slug the request's token
 * resolved to — never a coworker from the model — and answer in plain words
 * plus ids so the coworker can relay them as they stand; a refusal is a
 * sentence, never a stack trace.
 *
 * Assignments reuse the existing local store and run gate (nothing is stored
 * twice); memory and soul go through `self-memory.mjs`, so every write is
 * atomic, refuses secrets, and lands in the changes log the Memory view undoes.
 * No Electron imports: exercised by `node --test electron/assignment-tools.test.mjs`.
 */
import { ASSIGNMENT_TOOL_NAMES, SELF_TOOL_NAMES } from "../src/lib/coworker-tools.ts";
import { ScheduleError, isSharedSchedule, parseLocalSchedule } from "../src/lib/local-schedule.ts";
import { describeMoment, describeRowStatus, describeScheduleForPeople } from "../src/lib/responsibility-copy.ts";
import { localRunEntry } from "../src/lib/run-history.ts";
import {
  createLocalResponsibility,
  deleteLocalResponsibility,
  listLocalResponsibilities,
  updateLocalResponsibility,
} from "./local-responsibilities.mjs";
import { MemoryError, forgetFact, noteProgress, readSelf, rememberFact, updateSoul } from "./self-memory.mjs";

const SCHEDULE_SCHEMA = {
  type: "object",
  description: [
    "When it runs. kind \"daily\": hour, minute. kind \"weekly\": daysOfWeek (0 = Sunday … 6 = Saturday), hour, minute. kind \"once\": at (milliseconds since the epoch).",
    "kind \"interval\" (this Mac only): everyMinutes (60, 120, 180, 240, 360, 480, or 720), optional from and until as \"HH:MM\" for an active window, optional daysOfWeek, maxPerDay (default 4).",
    "kind \"cron\" (this Mac only): expression with five fields (minute hour day-of-month month day-of-week), maxPerDay (default 4).",
    "timezone is optional and defaults to the coworker's own; never invent one.",
  ].join(" "),
  properties: {
    kind: { type: "string", enum: ["daily", "weekly", "once", "interval", "cron"] },
    hour: { type: "integer", minimum: 0, maximum: 23 },
    minute: { type: "integer", minimum: 0, maximum: 59 },
    daysOfWeek: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } },
    at: { type: "integer", description: "For kind once: the moment in milliseconds since the epoch." },
    timezone: { type: "string", description: "Optional IANA time zone; defaults to the coworker's own." },
    everyMinutes: { type: "integer", enum: [60, 120, 180, 240, 360, 480, 720] },
    from: { type: "string", description: "Interval window start, \"HH:MM\"." },
    until: { type: "string", description: "Interval window end, \"HH:MM\"." },
    maxPerDay: { type: "integer", minimum: 1 },
    expression: { type: "string", description: "For kind cron: five fields, e.g. \"0 9 * * 1-5\"." },
  },
  required: ["kind"],
};

/** The assignment tools as the engine lists them; names match `src/lib/coworker-tools.ts`. */
export function assignmentToolCatalog() {
  return [
    {
      name: "assignments_list",
      description: "List your assignments: name, schedule in words, next run, last outcome, and the id to use with the other assignment tools.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "assignment_create",
      description: [
        "Set up an assignment: work you do on a schedule. Give it a short name, the instructions you will follow on every run, and a schedule.",
        "placement is \"local\" by default (this Mac, only while Open Coworker is open, with access to your files) or \"cloud\" (OpenWork Cloud, runs even when this Mac is off, without your local files; only when the person is signed in and asks for it).",
        "Cloud takes daily, weekly, or once schedules only. Ask the person when the day, time, or place is unclear.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short name, as the person would say it: \"Move the car\"." },
          instructions: { type: "string", description: "What to do on every run, in full sentences." },
          schedule: SCHEDULE_SCHEMA,
          placement: { type: "string", enum: ["local", "cloud"], description: "Where it runs; local unless asked otherwise." },
        },
        required: ["name", "instructions", "schedule"],
      },
    },
    {
      name: "assignment_update",
      description: "Change an assignment on this Mac: its name, its instructions, its schedule, or whether it is active (active false pauses it, true resumes it). Only include what changes.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          patch: {
            type: "object",
            properties: {
              name: { type: "string" },
              instructions: { type: "string" },
              schedule: SCHEDULE_SCHEMA,
              active: { type: "boolean" },
            },
          },
        },
        required: ["id", "patch"],
      },
    },
    {
      name: "assignment_run_now",
      description: "Run an assignment on this Mac now, without waiting for its schedule. It waits its turn if this Mac is busy with other runs.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    {
      name: "assignment_remove",
      description: "Remove an assignment from this Mac for good. Its past runs stay in the person's history only as conversations.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  ];
}

/** The memory and soul tools as the engine lists them. */
export function selfToolCatalog() {
  return [
    {
      name: "memory_remember",
      description: [
        "Record something worth keeping. kind \"working\" is for what the current work needs (curated, small); kind \"long-term\" is for what will still be true next month, filed under a short topic such as \"About you\" or \"Tools we use\".",
        "A fact moved from working to long-term memory leaves working memory. Never record trivia, secrets, or anything the person asked you to keep out.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "One fact or preference, as a plain sentence." },
          kind: { type: "string", enum: ["working", "long-term"] },
          topic: { type: "string", description: "For long-term memory: the topic file it belongs to." },
        },
        required: ["text", "kind"],
      },
    },
    {
      name: "memory_forget",
      description: "Forget something: a line in working memory or a long-term memory, or a whole long-term memory when you name its topic.",
      inputSchema: { type: "object", properties: { target: { type: "string", description: "The line to forget, or the topic of a memory to drop." } }, required: ["target"] },
    },
    {
      name: "memory_note",
      description: [
        "Keep one line in working memory saying where a piece of work stands, so the person can see what you are doing and you can pick it up again after an interruption.",
        "Call it before you start anything longer than a quick answer (what you are doing, what done looks like, the next step) and again after each meaningful step, finding, or change of plan — not after every tool call. The same work name replaces the previous note in place; an empty text clears it when the work is done or dropped.",
        "One or two lines per piece of work, never a log: details belong in a document, and what stays true belongs in long-term memory. Open Coworker keeps this line for each of your Workers itself.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          work: { type: "string", description: "The piece of work, in a few words, e.g. \"Vendor comparison\". Use the same words each time." },
          text: { type: "string", description: "Where it stands now: done so far, what you found, what comes next, what you are waiting on. Empty to clear the note." },
        },
        required: ["work"],
      },
    },
    {
      name: "soul_update",
      description: [
        "Change how you work, inside one section of your soul: Role and Mission are one paragraph each (add a sentence, replace or remove a phrase, or rewrite); Principles and Communication are bullet lists (add a line, replace or remove the line that mentions target, or rewrite).",
        "Use it when the person sets a standing rule, a boundary, or how they want you to communicate. State a significant change in one sentence and continue unless they object.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          section: { type: "string", enum: ["Role", "Mission", "Principles", "Communication"] },
          change: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["add", "replace", "remove", "rewrite"] },
              text: { type: "string", description: "The new line, sentence, or whole section text." },
              target: { type: "string", description: "For replace and remove: words from the line to change." },
            },
            required: ["kind"],
          },
        },
        required: ["section", "change"],
      },
    },
    {
      name: "self_read",
      description: "Read your own files back — \"soul\", \"working\", \"long-term\", \"memory\" (working and long-term), or \"everything\" — to answer honestly about what you know or how you are meant to behave.",
      inputSchema: { type: "object", properties: { what: { type: "string", enum: ["soul", "working", "long-term", "memory", "everything"] } } },
    },
  ];
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idOf(args) {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) throw new MemoryError("Say which assignment, by its id from assignments_list.");
  return id;
}

/** How a person would read one local assignment, for the model to relay. */
function describeLocalAssignment(item, now) {
  const history = item.runs.map(localRunEntry);
  const latest = history[0];
  const finished = history.find((entry) => entry.outcome !== "running" && entry.outcome !== "queued");
  const status = describeRowStatus({ latest, finished, paused: item.state !== "active", needsAttention: false, nextDueAt: item.nextDueAt }, { now });
  return `${item.name} (id ${item.id}) · ${describeScheduleForPeople(item.schedule)} · ${status}`;
}

function placementOf(args) {
  const value = typeof args.placement === "string" ? args.placement.trim().toLowerCase() : "";
  if (!value || value === "local" || value === "this-mac" || value === "this mac" || value === "mac") return "local";
  if (value === "cloud" || value === "openwork-cloud" || value === "openwork cloud") return "cloud";
  throw new MemoryError('Placement is "local" (this Mac, the default) or "cloud" (OpenWork Cloud, when signed in).');
}

/** The facts the app's receipts and Memory view may read beside the sentence for the model. */
function assignmentCard(item, extra = {}) {
  return { id: item.id, name: item.name, schedule: item.schedule, state: item.state, nextDueAt: item.nextDueAt, ...extra };
}

const VERBS = {
  assignments_list: "check the assignments",
  assignment_create: "create the assignment",
  assignment_update: "change the assignment",
  assignment_run_now: "start the assignment",
  assignment_remove: "remove the assignment",
  memory_remember: "remember that",
  memory_forget: "forget that",
  memory_note: "note where the work stands",
  soul_update: "update how I work",
  self_read: "read my own files",
};

/**
 * Wrap a handler so every failure reaches the coworker as "Couldn't <do>:
 * <sentence>" — a schedule or memory refusal as it stands, anything else named
 * without a stack.
 */
function relayFailures(name, handler) {
  return async (slug, args) => {
    try {
      return await handler(slug, isRecord(args) ? args : {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const plain = error instanceof MemoryError || error instanceof ScheduleError || /required|not found/i.test(message);
      throw new Error(`Couldn't ${VERBS[name] ?? "do that"}: ${plain ? message : message || "something went wrong on this Mac"}`);
    }
  };
}

/**
 * Assignment handlers bound to the main process: `coworkersDir`, `settings()`
 * (the guardrails), `timezone()`, `runNow(slug, id)` (the same run gate the
 * panel uses), and `cloud` (null without an OpenWork account; otherwise
 * `{ create(slug, draft), list(slug) }`).
 */
export function createAssignmentToolHandlers(deps) {
  const storeOptions = async () => {
    const settings = await deps.settings();
    return {
      guardrails: { minimumGapMinutes: settings.minimumRunGapMinutes, maxRunsPerDay: settings.maxRunsPerDay },
      defaultTimezone: deps.timezone(),
    };
  };
  const cloud = () => (typeof deps.cloud === "function" ? deps.cloud() : deps.cloud ?? null);
  const localById = async (slug, id) => {
    const item = (await listLocalResponsibilities(deps.coworkersDir, slug)).find((candidate) => candidate.id === id);
    if (!item) throw new MemoryError("I don't have an assignment with that id on this Mac. Check assignments_list.");
    return item;
  };

  const handlers = {
    assignments_list: async (slug) => {
      const now = Date.now();
      const local = await listLocalResponsibilities(deps.coworkersDir, slug);
      const lines = [];
      if (local.length === 0) lines.push("No assignments on this Mac.");
      else {
        lines.push(`${local.length} assignment${local.length === 1 ? "" : "s"} on this Mac:`);
        for (const item of local) lines.push(`- ${describeLocalAssignment(item, now)}`);
      }
      const remote = cloud();
      if (remote) {
        try {
          const items = await remote.list(slug);
          if (items.length > 0) {
            lines.push(`${items.length} assignment${items.length === 1 ? "" : "s"} in OpenWork Cloud (these run even when this Mac is off; change them in OpenWork):`);
            for (const item of items) {
              lines.push(`- ${item.name} (OpenWork Cloud) · ${describeScheduleForPeople(item.schedule)}${item.nextDueAt ? ` · Next: ${describeMoment(item.nextDueAt, { now })}` : ""}${item.state !== "active" ? ` · ${item.state === "needs_attention" ? "Needs the person" : "Paused"}` : ""}`);
            }
          }
        } catch (error) {
          lines.push(`OpenWork Cloud assignments could not be read right now (${error instanceof Error ? error.message : String(error)}).`);
        }
      }
      return { text: lines.join("\n"), structured: { assignments: local.map((item) => assignmentCard(item)) } };
    },
    assignment_create: async (slug, args) => {
      const placement = placementOf(args);
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const instructions = typeof args.instructions === "string" ? args.instructions.trim() : "";
      if (!name) throw new MemoryError("Give the assignment a short name.");
      if (!instructions) throw new MemoryError("Say what to do on every run.");
      const options = await storeOptions();
      if (placement === "cloud") {
        const remote = cloud();
        if (!remote) throw new MemoryError("The person is not signed in to OpenWork, so this can only run on this Mac. Ask them to sign in for OpenWork Cloud, or set it up here.");
        const schedule = parseLocalSchedule(args.schedule, { defaultTimezone: options.defaultTimezone });
        if (!isSharedSchedule(schedule)) {
          throw new MemoryError("OpenWork Cloud runs daily, weekly, or once schedules only. An interval or a custom timetable can run on this Mac instead.");
        }
        const created = await remote.create(slug, { name, instructions, schedule });
        return {
          text: [
            `Created assignment "${created.name}" in OpenWork Cloud · ${describeScheduleForPeople(created.schedule)}`,
            `It runs even when this Mac is off${created.modelName ? `, using ${created.modelName}` : ""}, and cannot read your local files or memory.`,
            `Id: ${created.id}`,
          ].join("\n"),
          structured: { assignment: { id: created.id, name: created.name, schedule: created.schedule, placement: "cloud", action: "created" } },
        };
      }
      const created = await createLocalResponsibility(deps.coworkersDir, slug, { name, instructions, schedule: args.schedule }, Date.now(), options);
      return {
        text: [
          `Created assignment "${created.name}" · ${describeScheduleForPeople(created.schedule)}`,
          created.nextDueAt ? `Next run: ${describeMoment(created.nextDueAt)}` : "No next run is due yet.",
          "Runs on this Mac, only while Open Coworker is open.",
          `Id: ${created.id}`,
        ].join("\n"),
        structured: { assignment: assignmentCard(created, { placement: "local", action: "created" }) },
      };
    },
    assignment_update: async (slug, args) => {
      const id = idOf(args);
      const patch = isRecord(args.patch) ? args.patch : {};
      if (Object.keys(patch).length === 0) throw new MemoryError("Say what should change: name, instructions, schedule, or active.");
      const before = await localById(slug, id);
      const updated = await updateLocalResponsibility(deps.coworkersDir, slug, id, patch, Date.now(), await storeOptions());
      const lines = [];
      let action = "changed";
      if (patch.schedule !== undefined) lines.push(`Changed assignment "${updated.name}" · ${describeScheduleForPeople(updated.schedule)}`);
      else if (patch.active === false) {
        action = "paused";
        lines.push(`Paused assignment "${updated.name}"`);
      } else if (patch.active === true) {
        action = "resumed";
        lines.push(`Resumed assignment "${updated.name}"`);
      } else if (typeof patch.name === "string" && patch.name.trim() && patch.name.trim() !== before.name) {
        action = "renamed";
        lines.push(`Renamed assignment "${before.name}" to "${updated.name}"`);
      } else lines.push(`Changed assignment "${updated.name}"`);
      if (updated.state === "active") lines.push(updated.nextDueAt ? `Next run: ${describeMoment(updated.nextDueAt)}` : "No next run is due yet.");
      else lines.push("Future scheduled runs are paused. A queued or running run can still finish, and Run now remains available.");
      lines.push(`Id: ${updated.id}`);
      return { text: lines.join("\n"), structured: { assignment: assignmentCard(updated, { action, previousName: before.name }) } };
    },
    assignment_run_now: async (slug, args) => {
      const id = idOf(args);
      const item = await localById(slug, id);
      const result = await deps.runNow(slug, id);
      if (!result.accepted) {
        return {
          text: result.reason === "queued" ? `Assignment "${item.name}" is already waiting its turn.` : `Assignment "${item.name}" is already running.`,
          structured: { assignment: assignmentCard(item, { action: "unchanged" }) },
        };
      }
      return {
        text: result.queued
          ? `Started assignment "${item.name}" now · it waits its turn behind other runs on this Mac.`
          : `Started assignment "${item.name}" now`,
        structured: { assignment: assignmentCard(item, { action: result.queued ? "queued" : "started" }) },
      };
    },
    assignment_remove: async (slug, args) => {
      const id = idOf(args);
      const item = await localById(slug, id);
      if (item.latestRun?.status === "running") throw new MemoryError(`Assignment "${item.name}" is running right now; let it finish before removing it.`);
      await deleteLocalResponsibility(deps.coworkersDir, slug, id);
      return { text: `Removed assignment "${item.name}"`, structured: { assignment: assignmentCard(item, { action: "removed" }) } };
    },
  };
  return Object.fromEntries(ASSIGNMENT_TOOL_NAMES.map((name) => [name, relayFailures(name, handlers[name])]));
}

/** Memory and soul handlers: the bound coworker's own files, through `self-memory.mjs`. */
export function createSelfToolHandlers({ coworkersDir }) {
  const handlers = {
    memory_remember: async (slug, args) => {
      const result = await rememberFact(coworkersDir, slug, { text: args.text, kind: args.kind, topic: args.topic });
      return { text: result.output, structured: { changeId: result.change?.id ?? null } };
    },
    memory_forget: async (slug, args) => {
      const result = await forgetFact(coworkersDir, slug, { target: args.target });
      return { text: result.output, structured: { changeId: result.change?.id ?? null } };
    },
    memory_note: async (slug, args) => {
      const result = await noteProgress(coworkersDir, slug, { work: args.work, text: args.text });
      return { text: result.output, structured: { changeId: result.change?.id ?? null } };
    },
    soul_update: async (slug, args) => {
      const result = await updateSoul(coworkersDir, slug, { section: args.section, change: args.change });
      return { text: result.output, structured: { changeId: result.change?.id ?? null } };
    },
    self_read: async (slug, args) => {
      const result = await readSelf(coworkersDir, slug, { what: args.what });
      return { text: result.output };
    },
  };
  return Object.fromEntries(SELF_TOOL_NAMES.map((name) => [name, relayFailures(name, handlers[name])]));
}
