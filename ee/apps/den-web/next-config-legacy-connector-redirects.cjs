// The old connector editor lived at /dashboard/mcp-connections/all and
// /configured. Bookmarks, desktop links and older setup links keep working by
// landing on the connector list or the connector's own page.

const BASE = "/dashboard/mcp-connections";

function legacyConnectorRedirects() {
  return [
    { source: `${BASE}/all`, destination: BASE, permanent: false },
    { source: `${BASE}/all/:connectorId`, destination: `${BASE}/:connectorId`, permanent: false },
    {
      source: `${BASE}/configured`,
      has: [{ type: "query", key: "connectionId", value: "(?<connectionId>.+)" }],
      destination: `${BASE}/:connectionId`,
      permanent: false,
    },
    { source: `${BASE}/configured`, destination: BASE, permanent: false },
    {
      source: BASE,
      has: [{ type: "query", key: "quickAdd", value: "(?<catalogId>[A-Za-z0-9._-]+)" }],
      destination: `${BASE}/new/:catalogId`,
      permanent: false,
    },
  ];
}

module.exports = { legacyConnectorRedirects };
