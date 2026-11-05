// Compatibility at Den's protocol boundary; Better Auth still owns User writes.
export function projectScimResource(resource: Record<string, unknown>, url: URL) {
  const attributes = url.searchParams.get("attributes")?.split(",").map(value => value.trim().toLowerCase()).filter(Boolean)
  const excluded = url.searchParams.get("excludedAttributes")?.split(",").map(value => value.trim().toLowerCase()) ?? []
  return Object.fromEntries(Object.entries(resource).filter(([key]) => {
    const name = key.toLowerCase()
    // RFC 7644 §3.9: id is always returned; schemas identifies the representation.
    return name === "id" || name === "schemas" || (attributes?.length ? attributes.includes(name) : !excluded.includes(name))
  }))
}

export function paginateScimResources(resources: Record<string, unknown>[], url: URL) {
  const start = Number.parseInt(url.searchParams.get("startIndex") ?? "1", 10)
  const size = Number.parseInt(url.searchParams.get("count") ?? String(resources.length), 10)
  const startIndex = Number.isFinite(start) ? Math.max(1, start) : 1
  const count = Number.isFinite(size) ? Math.max(0, size) : resources.length
  const page = resources.slice(startIndex - 1, startIndex - 1 + count)
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: resources.length,
    startIndex,
    itemsPerPage: page.length,
    Resources: page.map(resource => projectScimResource(resource, url)),
  }
}

export function normalizeScimUserBody(body: Record<string, unknown>) {
  const normalized = { ...body }
  if (typeof body.displayName === "string") normalized.name = { ...(record(body.name) ?? {}), formatted: body.displayName }
  if (Array.isArray(body.Operations)) normalized.Operations = body.Operations.map((value: unknown) => {
    const operation = record(value)
    if (!operation) return value
    const path = typeof operation.path === "string" && operation.path.toLowerCase() === "displayname" ? "name.formatted" : operation.path
    const objectValue = record(operation.value)
    return { ...operation, ...(path === undefined ? {} : { path }), ...(objectValue && typeof objectValue.displayName === "string" ? { value: normalizeScimUserBody(objectValue) } : {}) }
  })
  return normalized
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
