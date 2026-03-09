export function headersToObject(headersInput) {
  const result = {};

  if (!headersInput) return result;

  if (typeof headersInput.forEach === "function") {
    headersInput.forEach((value, key) => {
      result[String(key).toLowerCase()] = String(value);
    });
    return result;
  }

  for (const [key, value] of Object.entries(headersInput)) {
    if (value == null) continue;
    result[String(key).toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  return result;
}

export function searchParamsToQuery(searchParams) {
  if (!searchParams || typeof searchParams.entries !== "function") {
    return {};
  }

  return Object.fromEntries(searchParams.entries());
}

export function buildRequestLike({ headers, searchParams } = {}) {
  return {
    headers: headersToObject(headers),
    query: searchParamsToQuery(searchParams)
  };
}
