import type { Metadata } from "next";
import { WorkbotScreen } from "./_components/workbot-screen";

export const metadata: Metadata = { title: "Workbot" };

export default function WorkbotPage() {
  return <WorkbotScreen />;
}
