export const dynamic = "force-static"

const linkset = {
  linkset: [
    {
      anchor: "https://api.openworklabs.com",
      "service-desc": [
        {
          href: "https://api.openworklabs.com/openapi.json",
          type: "application/vnd.oai.openapi+json;version=3.1",
          title: "OpenWork Den API — OpenAPI 3.1 document",
        },
      ],
      "service-doc": [
        {
          href: "https://openworklabs.com/docs/api-reference",
          type: "text/html",
          title: "OpenWork Den API — human documentation",
        },
      ],
      status: [
        {
          href: "https://api.openworklabs.com/health",
          type: "application/json",
          title: "OpenWork Den API — health endpoint",
        },
      ],
      "service-meta": [
        {
          href: "https://openworklabs.com/llms.txt",
          type: "text/plain",
          title: "OpenWork llms.txt — agent-facing site guide",
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
