import { HTTPException } from "hono/http-exception";

export type RequestActor = {
  kind: "anonymous" | "client" | "host";
};

export type AuthSummary = {
  actorKind: RequestActor["kind"];
  configured: {
    clientToken: boolean;
    hostToken: boolean;
  };
  headers: {
    authorization: "Authorization";
    hostToken: "X-OpenWork-Host-Token";
  };
  required: boolean;
  scopes: {
    hiddenWorkspaceReads: "host";
    serverInventory: "host";
    visibleRead: "client_or_host";
  };
};

function readBearer(headers: Headers) {
  const raw = headers.get("authorization")?.trim() ?? "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function trimToken(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

export type AuthService = ReturnType<typeof createAuthService>;

export function createAuthService() {
  const clientToken = trimToken(
    process.env.OPENWORK_SERVER_V2_CLIENT_TOKEN
      ?? process.env.OPENWORK_CLIENT_TOKEN
      ?? process.env.OPENWORK_TOKEN,
  );
  const hostToken = trimToken(
    process.env.OPENWORK_SERVER_V2_HOST_TOKEN
      ?? process.env.OPENWORK_HOST_TOKEN,
  );
  const required = Boolean(clientToken || hostToken);

  function resolveActor(headers: Headers): RequestActor {
    const hostHeader = headers.get("x-openwork-host-token")?.trim() ?? "";
    if (hostToken && hostHeader && hostHeader === hostToken) {
      return { kind: "host" };
    }

    const bearer = readBearer(headers);
    if (hostToken && bearer && bearer === hostToken) {
      return { kind: "host" };
    }

    if (clientToken && bearer && bearer === clientToken) {
      return { kind: "client" };
    }

    return { kind: "anonymous" };
  }

  function getSummary(actor: RequestActor): AuthSummary {
    return {
      actorKind: actor.kind,
      configured: {
        clientToken: Boolean(clientToken),
        hostToken: Boolean(hostToken),
      },
      headers: {
        authorization: "Authorization",
        hostToken: "X-OpenWork-Host-Token",
      },
      required,
      scopes: {
        hiddenWorkspaceReads: "host",
        serverInventory: "host",
        visibleRead: "client_or_host",
      },
    };
  }

  function requireVisibleRead(actor: RequestActor) {
    if (!required) {
      return;
    }

    if (actor.kind === "anonymous") {
      throw new HTTPException(401, {
        message: "A client or host token is required for this route.",
      });
    }
  }

  function requireHost(actor: RequestActor) {
    if (!required) {
      return;
    }

    if (actor.kind === "anonymous") {
      throw new HTTPException(401, {
        message: "A host token is required for this route.",
      });
    }

    if (actor.kind !== "host") {
      throw new HTTPException(403, {
        message: "Host scope is required for this route.",
      });
    }
  }

  return {
    getSummary,
    requireHost,
    requireVisibleRead,
    resolveActor,
  };
}
