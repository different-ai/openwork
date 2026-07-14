import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const VAULT_KEY_ENV = "OPENWORK_CONNECT_VAULT_KEY";
const VAULT_CONTEXT = "openwork-connect-v1";
const AUTHORIZATION_CONTEXT = `${VAULT_CONTEXT}:oauth-authorization`;

export type ConnectVaultStatus =
  | { status: "ready" }
  | { status: "missing"; message: string }
  | { status: "invalid"; message: string };

function decodeVaultKey(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const bytes = trimmed.startsWith("hex:")
      ? Buffer.from(trimmed.slice(4), "hex")
      : Buffer.from(trimmed.replace(/^base64url:/, ""), "base64url");
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export function readConnectVaultStatus(env: NodeJS.ProcessEnv = process.env): ConnectVaultStatus {
  const value = env[VAULT_KEY_ENV];
  if (!value?.trim()) {
    return {
      status: "missing",
      message: `${VAULT_KEY_ENV} is required before Local Connect can store credentials.`,
    };
  }
  if (!decodeVaultKey(value)) {
    return {
      status: "invalid",
      message: `${VAULT_KEY_ENV} must be a base64url or hex encoded 32-byte key.`,
    };
  }
  return { status: "ready" };
}

function requireVaultKey(env: NodeJS.ProcessEnv): Buffer {
  const value = env[VAULT_KEY_ENV];
  const key = value ? decodeVaultKey(value) : null;
  if (!key) {
    const status = readConnectVaultStatus(env);
    throw new Error(status.status === "ready" ? "Connect vault key is unavailable." : status.message);
  }
  return key;
}

export class ConnectLocalVault {
  private readonly key: Buffer;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.key = requireVaultKey(env);
  }

  encrypt(value: unknown, scope: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${VAULT_CONTEXT}:${scope}`, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  decrypt(value: string, scope: string): unknown {
    const [version, ivValue, tagValue, ciphertextValue, ...extra] = value.split(".");
    if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue || extra.length > 0) {
      throw new Error("The Connect credential envelope is invalid.");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivValue, "base64url"));
    decipher.setAAD(Buffer.from(`${VAULT_CONTEXT}:${scope}`, "utf8"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  }

  agentToken(revision: string): string {
    return `owc_${createHmac("sha256", this.key).update(`${VAULT_CONTEXT}:agent-token:${revision}`).digest("base64url")}`;
  }

  verifiesAgentToken(candidate: string, revision: string): boolean {
    const expected = Buffer.from(this.agentToken(revision), "utf8");
    const received = Buffer.from(candidate, "utf8");
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  createAuthorizationId(input: {
    connectionId: string;
    redirectUri: string;
    now?: number;
    ttlMs?: number;
  }): string {
    const issuedAt = input.now ?? Date.now();
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      profile: "local-owner",
      connectionId: input.connectionId,
      redirectUri: input.redirectUri,
      nonce: randomBytes(24).toString("base64url"),
      issuedAt,
      expiresAt: issuedAt + (input.ttlMs ?? 10 * 60_000),
    })).toString("base64url");
    const signature = createHmac("sha256", this.key)
      .update(`${AUTHORIZATION_CONTEXT}:${payload}`)
      .digest("base64url");
    return `owca_${payload}.${signature}`;
  }

  verifiesAuthorizationId(input: {
    candidate: string;
    connectionId: string;
    redirectUri: string;
    now?: number;
  }): boolean {
    const [payload, receivedSignature, ...extra] = input.candidate.replace(/^owca_/, "").split(".");
    if (!input.candidate.startsWith("owca_") || !payload || !receivedSignature || extra.length > 0) return false;
    const expectedSignature = createHmac("sha256", this.key)
      .update(`${AUTHORIZATION_CONTEXT}:${payload}`)
      .digest("base64url");
    const expected = Buffer.from(expectedSignature, "utf8");
    const received = Buffer.from(receivedSignature, "utf8");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return false;
    try {
      const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (typeof value !== "object" || value === null) return false;
      const record = Object.fromEntries(Object.entries(value));
      const now = input.now ?? Date.now();
      return record.version === 1
        && record.profile === "local-owner"
        && record.connectionId === input.connectionId
        && record.redirectUri === input.redirectUri
        && typeof record.issuedAt === "number"
        && typeof record.expiresAt === "number"
        && record.issuedAt <= now
        && record.expiresAt > now;
    } catch {
      return false;
    }
  }
}
