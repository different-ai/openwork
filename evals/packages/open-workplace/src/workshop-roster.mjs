#!/usr/bin/env node
// Generate credentials directly into a new private file. Never print credentials.
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const [path, rawCount = "20"] = process.argv.slice(2);
const count = Number(rawCount);
if (!path || !Number.isInteger(count) || count < 1 || count > 100) {
  console.error("Usage: node src/workshop-roster.mjs /private/path/participants.json [1–100]");
  process.exitCode = 1;
} else {
  const participants = Array.from({ length: count }, (_, i) => {
    const number = String(i + 1).padStart(2, "0");
    return { id: `participant-${number}`, name: `Participant ${number}`, token: randomBytes(32).toString("base64url") };
  });
  try {
    await writeFile(path, JSON.stringify(participants, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(`Created a private roster for ${count} participants. Distribute only each person's own access code; never share the roster.`);
  } catch { console.error("Could not create the roster. Choose a new file in an existing private directory; existing files are never overwritten."); process.exitCode = 1; }
}
