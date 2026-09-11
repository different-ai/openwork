/** @jsxImportSource react */
import { useEffect } from "react";

import { useEnterpriseActivationRequired } from "@/react-app/domains/cloud/enterprise-activation-gate";
import { startGlobalQueueDrainer } from "./global-queue-drainer";

export function GlobalQueueDrainerBridge() {
  if (useEnterpriseActivationRequired()) return null;
  return <ActivatedGlobalQueueDrainerBridge />;
}

function ActivatedGlobalQueueDrainerBridge() {
  useEffect(() => startGlobalQueueDrainer(), []);
  return null;
}
