import { readFile } from "node:fs/promises";
import { inspectDesktop } from "./desktop-state.mjs";

const services = JSON.parse(await readFile("/opt/openwork-preview/services.json", "utf8"));
if (Object.keys(services).length !== 1 || services.desktop !== "http://127.0.0.1:6080") throw new Error("Invalid desktop-only services");
const viewer = await fetch(`${services.desktop}/vnc.html`, { signal: AbortSignal.timeout(10_000) });
if (!viewer.ok || !(await viewer.text()).includes("noVNC")) throw new Error("Desktop viewer unavailable");
await inspectDesktop();
