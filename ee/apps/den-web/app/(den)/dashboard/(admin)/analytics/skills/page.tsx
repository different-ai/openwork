import { Suspense } from "react";
import { SkillUsageScreen } from "../../../_features/skill-usage/skill-usage-screen";

export default function SkillUsageAnalyticsPage() {
  return <Suspense fallback={null}><SkillUsageScreen /></Suspense>;
}
