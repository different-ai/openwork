"use client";

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AdminFreeAutoConversions } from "@openwork/types/den/admin-free-auto";

export default function ConversionChart({ daily }: { daily: AdminFreeAutoConversions["daily"] }) {
  return <div className="h-64 w-full min-w-0 max-w-full overflow-hidden" data-testid="free-auto-conversion-chart">
    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
      <LineChart data={daily} accessibilityLayer margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--dls-border)" strokeDasharray="3 3" />
        <XAxis dataKey="date" tickFormatter={(date: string) => date.slice(5)} minTickGap={32} tickLine={false} axisLine={false} fontSize={11} />
        <YAxis allowDecimals={false} width={35} tickLine={false} axisLine={false} fontSize={11} />
        <Tooltip /><Legend wrapperStyle={{ fontSize: 12 }} />
        <Line name="Reached limit" dataKey="reachedLimit" stroke="var(--dls-text-primary)" strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line name="Signed in afterward" dataKey="signedIn" stroke="var(--dls-text-secondary)" strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line name="New account" dataKey="newAccounts" stroke="var(--ow-warning)" strokeDasharray="4 3" strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line name="Paid subscription" dataKey="subscribed" stroke="var(--ow-success)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  </div>;
}
