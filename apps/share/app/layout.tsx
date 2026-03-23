import "../styles/globals.css";

import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Script from "next/script";

import { DEFAULT_PUBLIC_BASE_URL } from "../server/_lib/share-utils.ts";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter"
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono"
});

export const metadata: Metadata = {
  metadataBase: new URL(DEFAULT_PUBLIC_BASE_URL),
  title: {
    default: "OpenWork Share",
    template: "%s - OpenWork Share"
  },
  description: "Publish OpenWork worker packages and shareable import links.",
  icons: { icon: "/openwork-mark.svg" },
  openGraph: {
    type: "website",
    siteName: "OpenWork Share",
  },
  twitter: {
    card: "summary_large_image",
    site: "@getopenwork",
  },
};

const defaultPosthogKey = "phc_4YnPTlDVYPjgwKvLuNxhbHjV5kadgvd7XLzVHWnCXAI";
const defaultPosthogHost = "https://us.i.posthog.com";
const posthogKey =
  process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim() ||
  process.env.NEXT_PUBLIC_POSTHOG_API_KEY?.trim() ||
  defaultPosthogKey;
const posthogHost = (process.env.NEXT_PUBLIC_POSTHOG_HOST ?? defaultPosthogHost).trim();

const posthogBootstrap = posthogKey
  ? `!function(t,e){var o,n,p,r;e.__SV||(window.posthog&&window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture identify alias reset register unregister setPersonProperties".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])})}(document,window.posthog||[]);
posthog.init(${JSON.stringify(posthogKey)}, {
  api_host: ${JSON.stringify(posthogHost)},
  defaults: '2026-01-30',
  person_profiles: 'identified_only',
  autocapture: true,
  capture_pageview: 'history_change',
  capture_pageleave: true
});`
  : "";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        {posthogBootstrap ? (
          <Script id="posthog" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: posthogBootstrap }} />
        ) : null}
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
