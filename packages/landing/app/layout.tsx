import "./globals.css";
import { JetBrains_Mono, Sora } from "next/font/google";

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
  display: "swap"
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap"
});

export const metadata = {
  title: "AikaOS por AikaLabs — Agentes IA para empresas en Latinoamérica",
  description:
    "AikaOS es la plataforma de automatización con agentes IA preconfigurados para legal, contabilidad, retail, marketing y más. Diseñada para LATAM."
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className={`${sora.variable} ${jetbrains.variable}`}>
      <body className="antialiased text-ink">
        {children}
      </body>
    </html>
  );
}
