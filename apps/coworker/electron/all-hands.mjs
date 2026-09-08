import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGroup, getGroup } from "./groups.mjs";

const defaults = { enabled: false, frequency: "morning", morning: "09:00", afternoon: "16:00", focus: "", groupId: "", enabledAt: 0, lastOccurrence: "", lastRequestedAt: 0 };
const queues = new Map();
const file = (dir) => path.join(dir, ".all-hands.json");
function serial(dir, action) {
  const next = (queues.get(dir) ?? Promise.resolve()).catch(() => {}).then(action);
  queues.set(dir, next);
  return next;
}
export async function readAllHands(dir) {
  try { return { ...defaults, ...JSON.parse(await readFile(file(dir), "utf8")) }; }
  catch (error) { if (error.code === "ENOENT") return { ...defaults }; throw error; }
}
async function save(dir, value) {
  await mkdir(dir, { recursive: true });
  await writeFile(`${file(dir)}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(`${file(dir)}.tmp`, file(dir));
  return value;
}
export function updateAllHands(dir, patch) {
  return serial(dir, async () => {
    const current = await readAllHands(dir);
    const next = { ...current };
    for (const key of Object.keys(patch)) {
      const value = patch[key];
      if (key === "enabled" && typeof value === "boolean") next.enabled = value;
      else if (key === "frequency" && ["morning", "twice", "manual"].includes(value)) next.frequency = value;
      else if (["morning", "afternoon"].includes(key) && typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) next[key] = value;
      else if (key === "focus" && typeof value === "string" && value.length <= 2000) next.focus = value.trim();
      else throw new Error(`Invalid All Hands setting: ${key}`);
    }
    if (next.frequency === "twice" && next.afternoon <= next.morning) throw new Error("The second briefing must be after the morning briefing.");
    if (next.enabled && !current.enabled) next.enabledAt = Date.now();
    return save(dir, next);
  });
}
export function prepareAllHands(dir, coworkers) {
  return serial(dir, async () => {
    const settings = await readAllHands(dir);
    if (!settings.enabled) return null;
    if (settings.groupId) {
      const group = await getGroup(dir, settings.groupId);
      if (!group.archivedAt) return group;
    }
    if (coworkers.length < 2) return null;
    const group = await createGroup(dir, { name: "All Hands", participantSlugs: coworkers.map((coworker) => coworker.slug) });
    await save(dir, { ...settings, groupId: group.id });
    return group;
  });
}
/** Latest eligible slot only: opening after a missed morning never replays a backlog. */
export function dueAllHands(settings, now = new Date()) {
  if (!settings.enabled || settings.frequency === "manual" || !settings.groupId) return null;
  const times = settings.frequency === "twice" ? [settings.afternoon, settings.morning] : [settings.morning];
  for (const time of times) {
    const [hour, minute] = time.split(":").map(Number);
    const at = new Date(now); at.setHours(hour, minute, 0, 0);
    const id = `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}-${time}`;
    if (at.getTime() <= now.getTime() && at.getTime() >= settings.enabledAt) {
      return id === settings.lastOccurrence || at.getTime() <= settings.lastRequestedAt ? null : { id: `all-hands:${id}`, occurrence: id, at: at.getTime() };
    }
  }
  return null;
}
export function claimAllHands(dir) {
  return serial(dir, async () => {
    const settings = await readAllHands(dir);
    const due = dueAllHands(settings);
    if (!due) return null;
    // Reserve before inference. A crash cannot charge for the same briefing twice.
    await save(dir, { ...settings, lastOccurrence: due.occurrence, lastRequestedAt: Date.now() });
    return due;
  });
}
