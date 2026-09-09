import { readFileSync } from "node:fs"
import { Agent, fetch as undiciFetch } from "undici"

const inClusterTokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token"
const inClusterCaPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"

export class KubernetesApiError extends Error {
  readonly status: number
  readonly body: string

  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = "KubernetesApiError"
    this.status = status
    this.body = body
  }
}

export class KubernetesNotFoundError extends KubernetesApiError {
  constructor(resource: string, body: string) {
    super(`Kubernetes ${resource} not found`, 404, body)
    this.name = "KubernetesNotFoundError"
  }
}

export function isKubernetesNotFoundError(error: unknown) {
  return error instanceof KubernetesNotFoundError
    || (error instanceof KubernetesApiError && error.status === 404)
}

export type KubernetesClientConfig = {
  apiUrl?: string
  apiToken?: string
  apiCaFile?: string
}

type KubernetesObject = Record<string, unknown>

function readTokenFile(path: string) {
  return readFileSync(path, "utf8").trim()
}

function resolveBaseUrl(config: KubernetesClientConfig) {
  const explicit = config.apiUrl?.trim()
  if (explicit) {
    return explicit.replace(/\/+$/, "")
  }

  const host = process.env.KUBERNETES_SERVICE_HOST
  const port = process.env.KUBERNETES_SERVICE_PORT
  if (!host || !port) {
    throw new Error(
      "KUBERNETES_API_URL is required when not running inside a Kubernetes cluster",
    )
  }

  return `https://${host}:${port}`
}

export function createKubernetesClient(config: KubernetesClientConfig & { namespace: string }) {
  const baseUrl = resolveBaseUrl(config)
  const isInClusterCa = !config.apiCaFile && baseUrl.startsWith("https://")
    && Boolean(process.env.KUBERNETES_SERVICE_HOST)

  let cachedDispatcher: Agent | null = null

  function dispatcher(): Agent | null {
    if (!baseUrl.startsWith("https://")) {
      return null
    }

    if (cachedDispatcher) {
      return cachedDispatcher
    }

    const caPath = config.apiCaFile ?? (isInClusterCa ? inClusterCaPath : undefined)
    const ca = caPath ? readFileSync(caPath, "utf8") : undefined
    cachedDispatcher = new Agent({ connect: ca ? { ca } : {} })
    return cachedDispatcher
  }

  // ServiceAccount tokens rotate; resolve per request instead of caching.
  function authorizationHeader() {
    if (config.apiToken?.trim()) {
      return `Bearer ${config.apiToken.trim()}`
    }

    return `Bearer ${readTokenFile(inClusterTokenPath)}`
  }

  async function request(path: string, init: {
    method?: string
    body?: unknown
    contentType?: string
    accept?: string
  } = {}): Promise<string> {
    const headers: Record<string, string> = {
      Authorization: authorizationHeader(),
      Accept: init.accept ?? "application/json",
    }
    if (init.body !== undefined) {
      headers["Content-Type"] = init.contentType ?? "application/json"
    }

    const response = await undiciFetch(`${baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
      dispatcher: dispatcher() ?? undefined,
    })

    const text = await response.text()

    if (response.status === 404) {
      throw new KubernetesNotFoundError(path, text)
    }

    if (!response.ok) {
      throw new KubernetesApiError(
        `Kubernetes API ${init.method ?? "GET"} ${path} failed (${response.status}): ${text.slice(0, 400)}`,
        response.status,
        text,
      )
    }

    return text
  }

  async function requestJson<T extends KubernetesObject>(path: string, init?: Parameters<typeof request>[1]): Promise<T> {
    const text = await request(path, init)
    return text ? JSON.parse(text) as T : {} as T
  }

  const namespace = config.namespace

  return {
    namespace,
    async getDeployment(name: string) {
      return requestJson<KubernetesObject>(`/apis/apps/v1/namespaces/${namespace}/deployments/${name}`)
    },
    async createDeployment(manifest: KubernetesObject) {
      return requestJson<KubernetesObject>(`/apis/apps/v1/namespaces/${namespace}/deployments`, {
        method: "POST",
        body: manifest,
      })
    },
    async patchDeployment(name: string, patch: KubernetesObject, contentType = "application/strategic-merge-patch+json") {
      return requestJson<KubernetesObject>(`/apis/apps/v1/namespaces/${namespace}/deployments/${name}`, {
        method: "PATCH",
        body: patch,
        contentType,
      })
    },
    async deleteDeployment(name: string) {
      await request(`/apis/apps/v1/namespaces/${namespace}/deployments/${name}`, { method: "DELETE" })
    },
    async getService(name: string) {
      return requestJson<KubernetesObject>(`/api/v1/namespaces/${namespace}/services/${name}`)
    },
    async createService(manifest: KubernetesObject) {
      return requestJson<KubernetesObject>(`/api/v1/namespaces/${namespace}/services`, {
        method: "POST",
        body: manifest,
      })
    },
    async deleteService(name: string) {
      await request(`/api/v1/namespaces/${namespace}/services/${name}`, { method: "DELETE" })
    },
    async createSecret(manifest: KubernetesObject) {
      return requestJson<KubernetesObject>(`/api/v1/namespaces/${namespace}/secrets`, {
        method: "POST",
        body: manifest,
      })
    },
    async deleteSecret(name: string) {
      await request(`/api/v1/namespaces/${namespace}/secrets/${name}`, { method: "DELETE" })
    },
    async createPvc(manifest: KubernetesObject) {
      return requestJson<KubernetesObject>(`/api/v1/namespaces/${namespace}/persistentvolumeclaims`, {
        method: "POST",
        body: manifest,
      })
    },
    async getPvc(name: string) {
      return requestJson<KubernetesObject>(`/api/v1/namespaces/${namespace}/persistentvolumeclaims/${name}`)
    },
    async deletePvc(name: string) {
      await request(`/api/v1/namespaces/${namespace}/persistentvolumeclaims/${name}`, { method: "DELETE" })
    },
    async listPods(labelSelector: string) {
      const query = new URLSearchParams({ labelSelector })
      return requestJson<{ items?: KubernetesObject[] }>(`/api/v1/namespaces/${namespace}/pods?${query.toString()}`)
    },
    async getPod(name: string) {
      return requestJson<KubernetesObject>(`/api/v1/namespaces/${namespace}/pods/${name}`)
    },
    async getPodLogs(name: string, options: { tailLines?: number } = {}) {
      const query = new URLSearchParams()
      if (options.tailLines !== undefined) {
        query.set("tailLines", String(options.tailLines))
      }
      const suffix = query.size > 0 ? `?${query.toString()}` : ""
      return request(`/api/v1/namespaces/${namespace}/pods/${name}/log${suffix}`, {
        accept: "text/plain",
      })
    },
  }
}

export type KubernetesClient = ReturnType<typeof createKubernetesClient>
