import type { Metadata } from "next";
import { notFound } from "next/navigation";
import "@openwork/ui/coworker.css";
import "../coworker.css";
import "./deep-thinker.css";
import { DeepThinkerLaunch } from "../../../components/coworker-deep-thinker";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Think big. Work lean. — Open Coworker launch exploration",
  description: "A local exploration of Astra deep thinking, Flash-powered work, and a team you control.",
  robots: { index: false, follow: false },
  alternates: { canonical: null },
};

export default function DeepThinkerPage() {
  // A local-only exploration, not a new public product or availability claim.
  if (process.env.NODE_ENV !== "development" || process.env.OPENWORK_DEEP_THINKER_PREVIEW !== "1") notFound();
  return <DeepThinkerLaunch />;
}
