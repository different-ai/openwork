import { createHash, createHmac } from "node:crypto";
import {
  CLOUD_CODING_WORKER_ID_HEADER,
  CLOUD_CODING_WORKER_PROOF_HEADER,
  CLOUD_CODING_WORKER_PROOF_VERSION,
  cloudCodingWorkerProofMessage,
} from "@openwork/types/den/cloud-coding";

export function withCloudCodingWorkerProof<Headers extends Record<string, unknown>>(
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
): Headers {
  const workerId = env.DEN_WORKER_ID?.trim();
  const activityToken = env.DEN_ACTIVITY_HEARTBEAT_TOKEN?.trim();
  if (!workerId || !activityToken) return headers;
  const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization")?.[1];
  const bearer = typeof authorization === "string" ? /^Bearer\s+(\S+)$/i.exec(authorization.trim())?.[1] : undefined;
  if (!bearer) return headers;
  const bearerHash = createHash("sha256").update(bearer).digest("hex");
  const proof = createHmac("sha256", activityToken).update(cloudCodingWorkerProofMessage(workerId, bearerHash)).digest("hex");
  return {
    ...headers,
    [CLOUD_CODING_WORKER_ID_HEADER]: workerId,
    [CLOUD_CODING_WORKER_PROOF_HEADER]: `${CLOUD_CODING_WORKER_PROOF_VERSION}.${proof}`,
  };
}

export function openworkCloudV1RegistrationConfig(name: string, config: Record<string, unknown>) {
  if (name !== "openwork-cloud" || config.type !== "remote") return config;
  const headers = config.headers;
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return config;
  const headerMap: Record<string, unknown> = Object.fromEntries(Object.entries(headers));
  const signed = withCloudCodingWorkerProof(headerMap);
  return signed === headerMap ? config : { ...config, headers: signed };
}
