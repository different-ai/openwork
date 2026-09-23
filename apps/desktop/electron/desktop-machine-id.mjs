import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MACHINE_ID_DOMAIN = "openwork-desktop-free-machine-v1";

async function readOperatingSystemMachineId(platform, { exec = run, read = readFile, environment = process.env } = {}) {
  if (platform === "darwin") {
    const { stdout } = await exec("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 5000 });
    return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1];
  }
  if (platform === "win32") {
    const reg = path.win32.join(environment.SystemRoot || "C:\\Windows", "System32", "reg.exe");
    const { stdout } = await exec(reg, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { timeout: 5000, windowsHide: true });
    return /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(stdout)?.[1];
  }
  if (platform === "linux") {
    for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const value = (await read(file, "utf8")).trim();
        if (value) return value;
      } catch {}
    }
  }
  return undefined;
}

/**
 * A per-machine identifier for free Auto that survives reinstalls and cleared
 * app data. Only a salted SHA-256 of the OS identifier (IOPlatformUUID,
 * MachineGuid or /etc/machine-id) ever leaves the machine.
 */
export async function readDesktopMachineId(platform = process.platform, dependencies) {
  const raw = (await readOperatingSystemMachineId(platform, dependencies))?.trim().toLowerCase();
  if (!raw || raw.length < 8 || /^[0-]+$/.test(raw) || /^[f-]+$/.test(raw)) {
    throw new Error("Desktop free inference requires a stable machine identifier.");
  }
  return createHash("sha256").update(`${MACHINE_ID_DOMAIN}:${raw}`).digest("hex");
}
