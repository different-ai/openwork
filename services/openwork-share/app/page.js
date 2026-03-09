import ShareHomeClient from "../components/share-home-client";
import ShareNav from "../components/share-nav";
import { ResponsiveGrain } from "../components/responsive-grain";
import { DEFAULT_PUBLIC_BASE_URL } from "../server/_lib/share-utils.js";

export const revalidate = 3600;

const rootOgImageUrl = `${DEFAULT_PUBLIC_BASE_URL}/og/root`;

export const metadata = {
  title: "Package Your Worker",
  description: "Drag and drop OpenWork skills, agents, commands, or MCP config to publish a shareable worker package.",
  alternates: {
    canonical: DEFAULT_PUBLIC_BASE_URL
  },
  openGraph: {
    type: "website",
    title: "Package Your Worker",
    description: "Drop skills, agents, or MCPs into OpenWork Share and publish a worker package in one move.",
    url: DEFAULT_PUBLIC_BASE_URL,
    images: [rootOgImageUrl]
  },
  twitter: {
    card: "summary_large_image",
    title: "Package Your Worker",
    description: "Drop skills, agents, or MCPs into OpenWork Share and publish a worker package in one move.",
    images: [rootOgImageUrl]
  }
};

function formatCompact(value) {
  try {
    return new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1
    }).format(value);
  } catch {
    return String(value);
  }
}

async function getStars() {
  try {
    const response = await fetch("https://api.github.com/repos/different-ai/openwork", {
      headers: {
        Accept: "application/vnd.github+json"
      },
      next: {
        revalidate: 3600
      }
    });

    if (!response.ok) {
      return "—";
    }

    const repo = await response.json();
    if (typeof repo?.stargazers_count === "number") {
      return formatCompact(repo.stargazers_count);
    }
  } catch {
    return "—";
  }

  return "—";
}

export default async function ShareHomePage() {
  const stars = await getStars();

  return (
    <>
      <div className="grain-background">
        <ResponsiveGrain
          colors={["#f6f9fc", "#f6f9fc", "#1e293b", "#334155"]}
          colorBack="#f6f9fc"
          softness={1}
          intensity={0.03}
          noise={0.14}
          shape="corners"
          speed={0.2}
        />
      </div>

      <main className="shell">
        <ShareNav stars={stars} />
        <ShareHomeClient />
      </main>
    </>
  );
}
