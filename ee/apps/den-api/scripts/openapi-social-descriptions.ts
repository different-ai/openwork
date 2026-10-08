const operationMethods = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function addOpenApiSocialDescriptions<T extends Record<string, unknown>>(original: T) {
  const document = structuredClone(original)
  const counts = { operationsVisited: 0, socialDescriptionsFilled: 0 }

  if (isRecord(document.paths)) {
    for (const pathItem of Object.values(document.paths)) {
      if (!isRecord(pathItem)) continue
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!operationMethods.has(method.toLowerCase()) || !isRecord(operation)) continue
        counts.operationsVisited += 1
        if (typeof operation.description === "string" && operation.description.trim()) continue
        if (typeof operation.summary !== "string" || !operation.summary.trim()) continue

        const mint = operation["x-mint"]
        if (Object.hasOwn(operation, "x-mint") && !isRecord(mint)) continue
        const extension = isRecord(mint) ? mint : {}
        const metadata = extension.metadata
        if (Object.hasOwn(extension, "metadata") && !isRecord(metadata)) continue
        const social = isRecord(metadata) ? metadata : {}
        if (Object.hasOwn(social, "og:description")) continue

        social["og:description"] = `${operation.summary} API reference in OpenWork Docs.`
        extension.metadata = social
        operation["x-mint"] = extension
        counts.socialDescriptionsFilled += 1
      }
    }
  }

  return { document, counts }
}
