const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "https://openworklabs.com";

function OrganizationJsonLd() {
  const data = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "OpenWork Labs",
    url: BASE_URL,
    logo: `${BASE_URL}/favicon-96x96.png`,
    description:
      "OpenWork is the open-source alternative to Claude Cowork. Create, share, and consume agentic workflows — local-first, cloud-ready, powered by OpenCode.",
    sameAs: [
      "https://github.com/different-ai/openwork",
      "https://x.com/openworklabs",
      "https://www.linkedin.com/company/openworklabs/",
    ],
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: "support@openworklabs.com",
      url: `${BASE_URL}/contact`,
    },
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

function WebSiteJsonLd() {
  const data = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "OpenWork",
    url: BASE_URL,
    description:
      "Open-source agentic workflows for individuals and teams. Local-first desktop app, cloud-ready, built on OpenCode.",
    publisher: {
      "@type": "Organization",
      name: "OpenWork Labs",
      url: BASE_URL,
    },
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

function SoftwareApplicationJsonLd() {
  const data = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "OpenWork",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Linux, Windows",
    description:
      "Open-source desktop app for creating, sharing, and consuming agentic workflows. Bring your own LLM, skills, and MCP servers.",
    url: BASE_URL,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      url: `${BASE_URL}/pricing`,
    },
    featureList: [
      "Local-first desktop app",
      "OpenCode-powered runtime",
      "Skills, plugins, and MCP server support",
      "Slack and Telegram chat surfaces",
      "Cloud workers (Den sandbox)",
      "Multi-provider: Anthropic, OpenAI, Gemini, Mistral, Groq",
      "Org-level skill hub for team distribution",
    ],
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

export default function JsonLd() {
  return (
    <>
      <OrganizationJsonLd />
      <WebSiteJsonLd />
      <SoftwareApplicationJsonLd />
    </>
  );
}

export function FAQPageJsonLd({
  faqs,
}: {
  faqs: { title: string; content: string[] }[];
}) {
  const data = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.title,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.content.join(" "),
      },
    })),
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

export function BreadcrumbJsonLd({
  items,
}: {
  items: { name: string; url: string }[];
}) {
  const data = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
