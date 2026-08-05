export const dynamic = "force-static"

const linkset = {
  linkset: [
    {
      anchor: "https://api.micxlabs.com",
      "service-desc": [
        {
          href: "https://api.micxlabs.com/openapi.json",
          type: "application/vnd.oai.openapi+json;version=3.1",
          title: "Micx Den API — OpenAPI 3.1 document",
        },
      ],
      "service-doc": [
        {
          href: "https://micxlabs.com/docs/api-reference",
          type: "text/html",
          title: "Micx Den API — human documentation",
        },
      ],
      status: [
        {
          href: "https://api.micxlabs.com/health",
          type: "application/json",
          title: "Micx Den API — health endpoint",
        },
      ],
      "service-meta": [
        {
          href: "https://micxlabs.com/llms.txt",
          type: "text/plain",
          title: "Micx llms.txt — agent-facing site guide",
        },
      ],
    },
  ],
}

export function GET() {
  return new Response(JSON.stringify(linkset, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/linkset+json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  })
}
