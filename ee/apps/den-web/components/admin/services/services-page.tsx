"use client";

import { useEffect, useState } from "react";
import { AdminAccessScreen } from "../admin-access-screen";
import { ServicesView } from "../../services/services-view";
import { useServicesReadiness } from "../../services/use-services-readiness";
import { adminServicesTransport } from "./admin-services-transport";

const CLOCK_MS = 30_000;

export function ServicesPage() {
  const readiness = useServicesReadiness(true, adminServicesTransport);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  const { state } = readiness;
  if (state.status === "signed-out" || state.status === "forbidden") {
    return <AdminAccessScreen state={state.status} onRetry={readiness.refresh} />;
  }
  return <ServicesView {...readiness} now={clock} testId="admin-services-page" />;
}
