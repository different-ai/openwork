"use client";

import { StackedDailyChart } from "../../../app/(den)/dashboard/_features/analytics/stacked-daily-chart";
import { useSeriesColors } from "../../../app/(den)/dashboard/_features/analytics/use-series-colors";
import type { FreeAutoUsageReport } from "./free-auto-usage-data";

const SERIES = [{ id: "members", label: "Members" }, { id: "guests", label: "Guests" }];

export default function FreeAutoSpendChart({ daily }: Pick<FreeAutoUsageReport, "daily">) {
  const colors = useSeriesColors(SERIES.map((series) => series.id), "free-auto-usage");
  const points = daily.map((day) => ({
    date: day.date, total: day.membersMicroUsd + day.guestsMicroUsd, values: { members: day.membersMicroUsd, guests: day.guestsMicroUsd },
  }));
  return <StackedDailyChart daily={points} series={SERIES} colors={colors} valueLabel="Free Auto spend" valueFormat="usd" emptyLabel="No free Auto usage in this range." />;
}
