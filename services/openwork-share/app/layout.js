import "../styles/globals.css";

import { DEFAULT_PUBLIC_BASE_URL } from "../server/_lib/share-utils.js";

export const metadata = {
  metadataBase: new URL(DEFAULT_PUBLIC_BASE_URL),
  title: {
    default: "OpenWork Share",
    template: "%s - OpenWork Share"
  },
  description: "Publish OpenWork worker packages and shareable import links."
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
