import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import { headers } from "next/headers";
import Script from "next/script";
import { getRequestBrandFavicon } from "./_lib/request-brand-favicon";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap"
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
  weight: ["400", "500"]
});

function metadataBaseFromOrigin(origin: string) {
  try {
    return new URL(origin);
  } catch {
    return new URL("http://localhost:3005");
  }
}

function firstHeaderValue(value: string | null) {
  return value?.split(",")[0]?.trim() || "";
}

function forwardedProtocol(value: string | null) {
  const protocol = firstHeaderValue(value).toLowerCase();
  return protocol === "http" || protocol === "https" ? protocol : "https";
}

export async function generateMetadata(): Promise<Metadata> {
  const configuredOrigin = process.env.DEN_WEB_PUBLIC_ORIGIN?.trim();
  const requestHeaders = await headers();
  const host = firstHeaderValue(requestHeaders.get("x-forwarded-host")) || firstHeaderValue(requestHeaders.get("host"));
  const protocol = forwardedProtocol(requestHeaders.get("x-forwarded-proto"));
  const metadataOrigin = configuredOrigin || (host ? `${protocol}://${host}` : "http://localhost:3005");

  return {
    metadataBase: metadataBaseFromOrigin(metadataOrigin),
    title: "OpenWork Cloud",
    description:
      "Share your OpenWork setup with your team, manage billing, and use OpenWork Cloud from app.openworklabs.com.",
    openGraph: {
      title: "OpenWork Cloud",
      description:
        "Share your OpenWork setup with your team and keep selected workflows available in OpenWork Cloud.",
      images: ["/opengraph-image"]
    },
    twitter: {
      card: "summary_large_image",
      title: "OpenWork Cloud",
      description:
        "Share your OpenWork setup with your team and manage OpenWork Cloud from app.openworklabs.com.",
      images: ["/opengraph-image"]
    }
  };
}

const defaultPosthogProxyPath = "/ow";
const posthogKey = process.env.DEN_WEB_POSTHOG_KEY?.trim() || "";
const posthogHost = (process.env.DEN_WEB_POSTHOG_HOST ?? defaultPosthogProxyPath).trim();

const posthogBootstrap = posthogKey
  ? `!function(t,e){var o,n,p,r;e.__SV||(window.posthog&&window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture identify alias reset register unregister setPersonProperties".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])})}(document,window.posthog||[]);
posthog.init(${JSON.stringify(posthogKey)}, {
  api_host: ${JSON.stringify(posthogHost)},
  defaults: '2025-11-30',
  person_profiles: 'identified_only'
});`
  : "";

export default async function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  const favicon = await getRequestBrandFavicon();

  return (
    <html lang="en" className={`${inter.variable} ${ibmPlexMono.variable}`}>
      <head>
        <link key={favicon.href} rel="icon" href={favicon.href} type={favicon.type} />
        {posthogBootstrap ? (
          <Script id="posthog" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: posthogBootstrap }} />
        ) : null}
      </head>
      <body>{children}</body>
    </html>
  );
}
