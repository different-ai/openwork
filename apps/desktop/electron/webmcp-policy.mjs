import { randomUUID } from "node:crypto";

const TOOLS_DIRECTIVE_PATTERN = /(?:^|,)\s*tools\s*=\s*\(([^)]*)\)/i;

function responseHeader(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "";
}

function serializedOrigin(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.origin === "null" ? null : url.origin;
  } catch {
    return null;
  }
}

export function permissionsPolicyAllows(header, documentOrigin, targetOrigin) {
  if (!header) return null;
  const match = TOOLS_DIRECTIVE_PATTERN.exec(header);
  if (!match) return null;
  const tokens = match[1].match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  if (tokens.length === 0) return false;
  return tokens.some((rawToken) => {
    const token = rawToken.replace(/^["']|["']$/g, "");
    if (token === "*") return true;
    if (token.toLowerCase() === "self") return targetOrigin === documentOrigin;
    if (token.toLowerCase() === "none") return false;
    return serializedOrigin(token) === targetOrigin;
  });
}

export function iframeAllowsTools(allow, parentOrigin, childOrigin, sourceOrigin = null) {
  const directives = String(allow ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  const directive = directives.find((value) => /^tools(?:\s|$)/i.test(value));
  if (!directive) return false;
  const tokens = directive.split(/\s+/).slice(1).map((value) => value.replace(/^["']|["']$/g, ""));
  // `allow="tools"` is the standard shorthand for delegating to the frame's
  // source origin only. A frame that has since navigated elsewhere, or whose
  // source origin cannot be read, is not covered by the shorthand; only an
  // explicit `*` token delegates to any origin.
  if (tokens.length === 0) return Boolean(sourceOrigin) && childOrigin === sourceOrigin;
  return tokens.some((token) => {
    if (token === "*") return true;
    if (token.toLowerCase() === "none") return false;
    if (token.toLowerCase() === "self") return childOrigin === parentOrigin;
    if (token.toLowerCase() === "src") return childOrigin === sourceOrigin;
    return serializedOrigin(token) === childOrigin;
  });
}

async function readIsolatedFramePolicy(frame, childIndex = null) {
  const replyChannel = `openwork:webmcp:policy-result:${randomUUID()}`;
  let ipc;
  let listener;
  let timer;
  try {
    const origin = frame.origin;
    const url = frame.url;
    ipc = frame.ipc;
    // Only the isolated preload receives this request. Never evaluate policy
    // getters in the page world or accept runtime facts through its public API.
    const result = await new Promise((resolve) => {
      listener = (event, value) => resolve(event.senderFrame === frame ? value : null);
      ipc.once(replyChannel, listener);
      timer = setTimeout(() => resolve(null), 3_000);
      frame.send("openwork:webmcp:read-policy", replyChannel, childIndex);
    });
    if (frame.detached || frame.isDestroyed() || frame.origin !== origin || frame.url !== url) return null;
    return result;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    if (ipc && listener) ipc.removeListener(replyChannel, listener);
  }
}

async function readEmbeddingPolicy(parent, child) {
  let childIndex = -1;
  try {
    childIndex = Array.from(parent.frames ?? []).indexOf(child);
  } catch {
    childIndex = -1;
  }
  if (childIndex < 0) return null;
  const result = await readIsolatedFramePolicy(parent, childIndex);
  // A sibling insertion/removal must not associate another element's delegation
  // with the child whose native frame identity we are checking.
  if (parent.frames[childIndex] !== child || child.parent !== parent) return null;
  return result?.embedding ?? null;
}

export function createWebMcpFramePolicy(browserSession) {
  const responses = new WeakMap();
  let installed = false;

  const headersListener = (details, callback) => {
    if ((details.resourceType === "mainFrame" || details.resourceType === "subFrame") && details.frame) {
      responses.set(details.frame, {
        url: details.url,
        permissionsPolicy: responseHeader(details.responseHeaders, "permissions-policy"),
        originAgentCluster: responseHeader(details.responseHeaders, "origin-agent-cluster"),
      });
    }
    callback({ responseHeaders: details.responseHeaders });
  };

  function install() {
    if (installed || !browserSession?.webRequest?.onHeadersReceived) return;
    browserSession.webRequest.onHeadersReceived(
      { urls: ["http://*/*", "https://*/*"] },
      headersListener,
    );
    installed = true;
  }

  async function checkFrame(frame) {
    if (!frame || frame.detached || frame.isDestroyed?.()) {
      return { allowed: false, originKeyed: false, reason: "detached_frame" };
    }
    const targetOrigin = serializedOrigin(frame.origin || frame.url);
    if (!targetOrigin) return { allowed: false, originKeyed: false, reason: "opaque_origin" };

    const chain = [];
    let current = frame;
    while (current) {
      chain.unshift(current);
      current = current.parent ?? null;
    }

    for (let index = 0; index < chain.length; index += 1) {
      const candidate = chain[index];
      const candidateOrigin = serializedOrigin(candidate.origin || candidate.url);
      if (!candidateOrigin) return { allowed: false, originKeyed: false, reason: "opaque_ancestor" };
      const metadata = responses.get(candidate);
      const ownPolicy = permissionsPolicyAllows(
        metadata?.permissionsPolicy ?? "",
        candidateOrigin,
        candidateOrigin,
      );
      if (ownPolicy === false) {
        return { allowed: false, originKeyed: true, reason: "permissions_policy" };
      }

      if (index === 0) continue;
      const parent = chain[index - 1];
      const parentOrigin = serializedOrigin(parent.origin || parent.url);
      const parentMetadata = responses.get(parent);
      const parentPolicy = permissionsPolicyAllows(
        parentMetadata?.permissionsPolicy ?? "",
        parentOrigin,
        candidateOrigin,
      );
      if (parentPolicy === false) {
        return { allowed: false, originKeyed: true, reason: "ancestor_permissions_policy" };
      }
      if (parentOrigin !== candidateOrigin) {
        const embedding = await readEmbeddingPolicy(parent, candidate);
        if (!embedding || !iframeAllowsTools(
          embedding.allow,
          parentOrigin,
          candidateOrigin,
          serializedOrigin(embedding.sourceOrigin),
        )) {
          return { allowed: false, originKeyed: true, reason: "missing_iframe_delegation" };
        }
      }
    }

    const targetMetadata = responses.get(frame);
    if (/^\s*\?0\s*$/i.test(targetMetadata?.originAgentCluster ?? "")) {
      return { allowed: true, originKeyed: false, reason: "origin_agent_cluster_opt_out" };
    }
    const runtimePolicy = await readIsolatedFramePolicy(frame);
    if (runtimePolicy?.originAgentCluster !== true || runtimePolicy?.domainMatchesHost !== true) {
      return { allowed: true, originKeyed: false, reason: "non_origin_keyed" };
    }
    return { allowed: true, originKeyed: true, reason: "allowed" };
  }

  return { checkFrame, install };
}
