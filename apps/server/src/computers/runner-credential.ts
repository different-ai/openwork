import { z } from "zod";
import type { ServerConfig } from "../types.js";

export const runnerCredentialSchema = z.strictObject({
  baseUrl: z.url().transform((value, ctx) => {
    const url = new URL(value);
    if (url.username || url.password || url.href.includes("?") || url.href.includes("#")
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
      ctx.addIssue({ code: "custom", message: "Use a secure organization address." });
      return z.NEVER;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  }),
  token: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/),
});
export type RunnerCredential = z.infer<typeof runnerCredentialSchema>;
const credentials = new WeakMap<ServerConfig, RunnerCredential>();

export const getRunnerCredential = (config: ServerConfig) => credentials.get(config) ?? null;
export function setRunnerCredential(config: ServerConfig, credential: RunnerCredential | null) {
  if (credential) credentials.set(config, credential);
  else credentials.delete(config);
}
