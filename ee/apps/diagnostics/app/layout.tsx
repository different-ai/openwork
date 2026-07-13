import type { Metadata } from "next"
import "./styles.css"

export const metadata: Metadata = {
  description: "Safely inspect inbound enterprise MCP client requests and responses.",
  robots: { follow: false, index: false },
  title: "OpenWork Diagnostics",
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>
}
