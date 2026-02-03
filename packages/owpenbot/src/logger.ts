import fs from "node:fs";
import path from "node:path";

import pino from "pino";

export function createLogger(level: string, options?: { logFile?: string }) {
  if (options?.logFile) {
    fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
    const destination = pino.destination({ dest: options.logFile, sync: false });
    return pino({ level, base: undefined }, destination);
  }

  return pino({
    level,
    base: undefined,
  });
}
