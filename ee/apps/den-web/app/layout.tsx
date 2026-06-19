import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import Script from "next/script";
import { ThemeProvider } from "./_components/theme-provider";
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
  metadataBase: new URL("https://app.openworklabs.com"),
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
  },
  icons: {
    icon: "/openwork-mark.svg"
  }
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

const themeScript = `(function(){var e=function(){try{var t=localStorage.getItem("openwork.theme");if(t==="dark"||t==="light")return t}catch(e){}return window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}();document.documentElement.dataset.theme=e;document.documentElement.classList.toggle("dark",e==="dark");document.documentElement.style.colorScheme=e})()`;

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${ibmPlexMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {posthogBootstrap ? (
          <Script id="posthog" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: posthogBootstrap }} />
        ) : null}
      </head>
      <body><ThemeProvider>{children}</ThemeProvider></body>
    </html>
  );
}
