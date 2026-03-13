import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import Script from "next/script";
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

export const metadata: Metadata = {
  title: "OpenWork Cloud",
  description:
    "Launch OpenWork cloud workers, handle Polar paywall flows, and operate Den from app.openwork.software."
};

const defaultPosthogKey = "phc_4YnPTlDVYPjgwKvLuNxhbHjV5kadgvd7XLzVHWnCXAI";
const defaultPosthogProxyPath = "/ow";
const posthogKey =
  process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim() ||
  process.env.NEXT_PUBLIC_POSTHOG_API_KEY?.trim() ||
  defaultPosthogKey;
const posthogHost = (process.env.NEXT_PUBLIC_POSTHOG_HOST ?? defaultPosthogProxyPath).trim();

const posthogBootstrap = posthogKey
  ? `!function(t,e){var o,n,p,r;e.__SV||(window.posthog&&window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture identify alias reset register unregister setPersonProperties".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])})}(document,window.posthog||[]);
posthog.init(${JSON.stringify(posthogKey)}, {
  api_host: ${JSON.stringify(posthogHost)},
  defaults: '2025-11-30',
  person_profiles: 'identified_only'
});`
  : "";

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${ibmPlexMono.variable}`}>
      <head>
        {posthogBootstrap ? (
          <Script id="posthog" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: posthogBootstrap }} />
        ) : null}
      </head>
      <body>{children}</body>
    </html>
  );
}
