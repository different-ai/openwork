import { createHash, randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type { ServerRepositories } from "../database/repositories.js";
import type { JsonObject, RouterBindingRecord, RouterIdentityRecord } from "../database/types.js";
import type { RuntimeService } from "./runtime-service.js";
import { RouteError } from "../http.js";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nowIso() {
  return new Date().toISOString();
}

async function fetchTelegramBotInfo(token: string) {
  const trimmed = token.trim();
  if (!trimmed) {
    return null as { id: number; name?: string; username?: string } | null;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${trimmed}/getMe`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    const json = await response.json().catch(() => null) as Record<string, unknown> | null;
    const result = asObject(json?.result);
    const id = Number(result.id);
    if (!Number.isFinite(id)) {
      return null;
    }
    return {
      id,
      name: typeof result.first_name === "string" ? result.first_name : undefined,
      username: typeof result.username === "string" ? result.username : undefined,
    };
  } catch {
    return null;
  }
}

function createPairingCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function pairingCodeHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export type RouterProductService = ReturnType<typeof createRouterProductService>;

export function createRouterProductService(input: {
  repositories: ServerRepositories;
  runtime: RuntimeService;
  serverId: string;
}) {
  function getIdentityOrThrow(identityId: string) {
    const identity = input.repositories.routerIdentities.getById(identityId);
    if (!identity || identity.serverId !== input.serverId) {
      throw new HTTPException(404, { message: `Router identity not found: ${identityId}` });
    }
    return identity;
  }

  function getBindingOrThrow(bindingId: string) {
    const binding = input.repositories.routerBindings.getById(bindingId);
    if (!binding || binding.serverId !== input.serverId) {
      throw new HTTPException(404, { message: `Router binding not found: ${bindingId}` });
    }
    return binding;
  }

  function listIdentities(kind?: "slack" | "telegram") {
    return input.repositories.routerIdentities.listByServer(input.serverId).filter((identity) => !kind || identity.kind === kind);
  }

  function listBindings(filters?: { channel?: string; identityId?: string }) {
    const identitiesById = new Map(listIdentities().map((identity) => [identity.id, identity] as const));
    return input.repositories.routerBindings.listByServer(input.serverId)
      .filter((binding) => {
        const identity = identitiesById.get(binding.routerIdentityId);
        if (!identity) {
          return false;
        }
        if (filters?.identityId?.trim() && binding.routerIdentityId !== filters.identityId.trim()) {
          return false;
        }
        if (filters?.channel?.trim() && identity.kind !== filters.channel.trim()) {
          return false;
        }
        return true;
      })
      .map((binding) => ({
        channel: identitiesById.get(binding.routerIdentityId)?.kind ?? "unknown",
        directory: normalizeString(asObject(binding.config).directory) || normalizeString(asObject(binding.config).workspacePath),
        identityId: binding.routerIdentityId,
        peerId: binding.bindingKey,
        updatedAt: Date.parse(binding.updatedAt) || undefined,
      }));
  }

  async function apply() {
    const health = await input.runtime.applyRouterConfig();
    return {
      applied: health.status === "running" || health.status === "disabled",
      applyError: health.status === "error" ? health.lastError ?? "Router apply failed." : undefined,
      applyStatus: health.status === "error" ? 502 : undefined,
      health,
      ok: true,
    };
  }

  function buildHealthSnapshot() {
    const runtimeHealth = input.runtime.getRouterHealth();
    const telegram = listIdentities("telegram").filter((identity) => identity.isEnabled);
    const slack = listIdentities("slack").filter((identity) => identity.isEnabled);
    return {
      config: {
        groupsEnabled: false,
      },
      channels: {
        slack: slack.length > 0,
        telegram: telegram.length > 0,
        whatsapp: false,
      },
      ok: runtimeHealth.status === "running" || runtimeHealth.status === "disabled",
      opencode: {
        healthy: runtimeHealth.status === "running",
        url: runtimeHealth.baseUrl ?? runtimeHealth.healthUrl ?? "",
        version: runtimeHealth.version ?? undefined,
      },
    };
  }

  function buildIdentityItem(identity: RouterIdentityRecord) {
    const config = asObject(identity.config);
    return {
      access: typeof config.access === "string" && (config.access === "private" || config.access === "public") ? config.access : undefined,
      enabled: identity.isEnabled,
      id: identity.id,
      pairingRequired: config.access === "private" || undefined,
      running: input.runtime.getRouterHealth().status === "running",
    };
  }

  function resolveIdentityForChannel(channel: "slack" | "telegram", identityId?: string) {
    if (identityId?.trim()) {
      const identity = getIdentityOrThrow(identityId.trim());
      if (identity.kind !== channel) {
        throw new RouteError(400, "invalid_request", `Identity ${identityId} is not a ${channel} identity.`);
      }
      return identity;
    }
    const fallback = listIdentities(channel).find((identity) => identity.isEnabled) ?? listIdentities(channel)[0] ?? null;
    if (!fallback) {
      throw new RouteError(400, "invalid_request", `No ${channel} identity is configured.`);
    }
    return fallback;
  }

  async function proxyRouter<T>(pathname: string, init?: { body?: unknown; method?: string }) {
    const health = input.runtime.getRouterHealth();
    if (!health.baseUrl || health.status !== "running") {
      throw new RouteError(503, "service_unavailable", "Router is not running.");
    }
    const response = await fetch(`${health.baseUrl.replace(/\/+$/, "")}${pathname}`, {
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: init?.method ?? "GET",
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new RouteError(response.status, "bad_gateway", typeof json?.error === "string" ? json.error : `Router request failed (${response.status}).`);
    }
    return json as T;
  }

  return {
    async apply() {
      return apply();
    },

    async deleteSlackIdentity(identityId: string) {
      const identity = getIdentityOrThrow(identityId);
      if (identity.kind !== "slack") {
        throw new RouteError(400, "invalid_request", "Router identity is not a Slack identity.");
      }
      input.repositories.routerIdentities.deleteById(identityId);
      const applied = await apply();
      return {
        ...applied,
        slack: {
          deleted: true,
          id: identityId,
        },
      };
    },

    async deleteTelegramIdentity(identityId: string) {
      const identity = getIdentityOrThrow(identityId);
      if (identity.kind !== "telegram") {
        throw new RouteError(400, "invalid_request", "Router identity is not a Telegram identity.");
      }
      input.repositories.routerIdentities.deleteById(identityId);
      const applied = await apply();
      return {
        ...applied,
        telegram: {
          deleted: true,
          id: identityId,
        },
      };
    },

    getHealth() {
      return buildHealthSnapshot();
    },

    async getTelegramInfo() {
      const identity = listIdentities("telegram")[0] ?? null;
      if (!identity) {
        return { bot: null, configured: false, enabled: false, ok: true };
      }
      const token = normalizeString(asObject(identity.auth).token) || normalizeString(asObject(identity.config).token);
      return {
        bot: await fetchTelegramBotInfo(token),
        configured: Boolean(token),
        enabled: identity.isEnabled,
        ok: true,
      };
    },

    listBindings(filters?: { channel?: string; identityId?: string }) {
      return { items: listBindings(filters), ok: true };
    },

    listRouterBindings() {
      return input.repositories.routerBindings.listByServer(input.serverId);
    },

    listRouterIdentities() {
      return input.repositories.routerIdentities.listByServer(input.serverId);
    },

    listSlackIdentities() {
      return { items: listIdentities("slack").map(buildIdentityItem), ok: true };
    },

    listTelegramIdentities() {
      return { items: listIdentities("telegram").map(buildIdentityItem), ok: true };
    },

    async sendMessage(inputValue: {
      autoBind?: boolean;
      channel: "slack" | "telegram";
      directory?: string;
      identityId?: string;
      peerId?: string;
      text: string;
    }) {
      const payload = {
        ...(inputValue.autoBind ? { autoBind: true } : {}),
        channel: inputValue.channel,
        ...(normalizeString(inputValue.directory) ? { directory: normalizeString(inputValue.directory) } : {}),
        ...(normalizeString(inputValue.identityId) ? { identityId: normalizeString(inputValue.identityId) } : {}),
        ...(normalizeString(inputValue.peerId) ? { peerId: normalizeString(inputValue.peerId) } : {}),
        text: inputValue.text,
      };
      return await proxyRouter<Record<string, unknown>>("/send", { body: payload, method: "POST" });
    },

    async setBinding(inputValue: { channel: "slack" | "telegram"; directory: string; identityId?: string; peerId: string }) {
      const identity = resolveIdentityForChannel(inputValue.channel, inputValue.identityId);
      const existing = input.repositories.routerBindings.listByServer(input.serverId)
        .find((binding) => binding.routerIdentityId === identity.id && binding.bindingKey === inputValue.peerId) ?? null;
      input.repositories.routerBindings.upsert({
        config: { directory: inputValue.directory },
        bindingKey: inputValue.peerId,
        id: existing?.id ?? `binding_${randomUUID()}`,
        isEnabled: true,
        routerIdentityId: identity.id,
        serverId: input.serverId,
      });
      await apply();
      return { ok: true };
    },

    async setSlackTokens(botToken: string, appToken: string) {
      return this.upsertSlackIdentity({ appToken, botToken, enabled: true, id: "default" });
    },

    async setTelegramEnabled(enabled: boolean, options?: { clearToken?: boolean }) {
      const identity = listIdentities("telegram")[0] ?? null;
      if (!identity) {
        throw new RouteError(404, "not_found", "Telegram identity is not configured.");
      }
      input.repositories.routerIdentities.upsert({
        ...identity,
        auth: options?.clearToken ? { ...identity.auth, token: null } : identity.auth,
        isEnabled: enabled,
      });
      const applied = await apply();
      return {
        ...applied,
        enabled,
      };
    },

    async setTelegramToken(token: string) {
      return this.upsertTelegramIdentity({ access: "public", enabled: true, id: "default", token });
    },

    async upsertRouterBinding(payload: Omit<RouterBindingRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }) {
      const binding = input.repositories.routerBindings.upsert(payload);
      await apply();
      return binding;
    },

    async upsertRouterIdentity(payload: Omit<RouterIdentityRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }) {
      const identity = input.repositories.routerIdentities.upsert(payload);
      await apply();
      return identity;
    },

    async updateBinding(bindingId: string, payload: { config?: JsonObject; isEnabled?: boolean; routerIdentityId?: string }) {
      const binding = getBindingOrThrow(bindingId);
      return await this.upsertRouterBinding({
        ...binding,
        config: payload.config ?? binding.config,
        isEnabled: payload.isEnabled ?? binding.isEnabled,
        routerIdentityId: payload.routerIdentityId ?? binding.routerIdentityId,
      });
    },

    async updateIdentity(identityId: string, payload: { auth?: JsonObject | null; config?: JsonObject; displayName?: string; isEnabled?: boolean }) {
      const identity = getIdentityOrThrow(identityId);
      return await this.upsertRouterIdentity({
        ...identity,
        auth: payload.auth ?? identity.auth,
        config: payload.config ?? identity.config,
        displayName: payload.displayName ?? identity.displayName,
        isEnabled: payload.isEnabled ?? identity.isEnabled,
      });
    },

    async upsertSlackIdentity(payload: { appToken: string; botToken: string; enabled?: boolean; id?: string }) {
      const id = normalizeString(payload.id) || `router_slack_${randomUUID()}`;
      input.repositories.routerIdentities.upsert({
        auth: {
          appToken: payload.appToken.trim(),
          botToken: payload.botToken.trim(),
        },
        config: {},
        displayName: id,
        id,
        isEnabled: payload.enabled !== false,
        kind: "slack",
        serverId: input.serverId,
      });
      const applied = await apply();
      return {
        ...applied,
        slack: {
          enabled: payload.enabled !== false,
          id,
        },
      };
    },

    async upsertTelegramIdentity(payload: { access?: "private" | "public"; enabled?: boolean; id?: string; token: string }) {
      const id = normalizeString(payload.id) || `router_telegram_${randomUUID()}`;
      const pairingCode = payload.access === "private" ? createPairingCode() : null;
      input.repositories.routerIdentities.upsert({
        auth: {
          token: payload.token.trim(),
        },
        config: {
          ...(payload.access ? { access: payload.access } : {}),
          ...(pairingCode ? { pairingCodeHash: pairingCodeHash(pairingCode) } : {}),
        },
        displayName: id,
        id,
        isEnabled: payload.enabled !== false,
        kind: "telegram",
        serverId: input.serverId,
      });
      const applied = await apply();
      const bot = await fetchTelegramBotInfo(payload.token);
      return {
        ...applied,
        telegram: {
          access: payload.access,
          ...(bot ? { bot } : {}),
          enabled: payload.enabled !== false,
          id,
          ...(pairingCode ? { pairingCode, pairingRequired: true } : {}),
        },
      };
    },
  };
}
