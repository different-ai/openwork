import OGImage from "../../components/og-image";
import { withSocialMetadata } from "../../lib/seo";

export const metadata = withSocialMetadata({
  openGraph: {
    title: "OpenWork — Social image preview",
    description: "Preview the OpenWork social sharing image."
  }
});

export default function OGPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f6f9fc] p-6">
      <OGImage />
    </main>
  );
}
