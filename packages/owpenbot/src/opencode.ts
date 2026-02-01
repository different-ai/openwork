import { Buffer } from "node:buffer";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import type { Config } from "./config.js";

type Client = ReturnType<typeof createOpencodeClient>;

export function createClient(config: Config): Client {
  const headers: Record<string, string> = {};
  if (config.opencodeUsername && config.opencodePassword) {
    const token = Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }

  return createOpencodeClient({
    baseUrl: config.opencodeUrl,
    directory: config.opencodeDirectory,
    headers: Object.keys(headers).length ? headers : undefined,
    responseStyle: "data",
    throwOnError: true,
  });
}

export function buildPermissionRules(mode: Config["permissionMode"]) {
  if (mode === "deny") {
    return [
      {
        permission: "*",
        pattern: "*",
        action: "deny" as const,
      },
    ];
  }

  return [
    {
      permission: "*",
      pattern: "*",
      action: "allow" as const,
    },
  ];
}
