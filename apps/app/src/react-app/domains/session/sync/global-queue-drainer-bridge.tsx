/** @jsxImportSource react */
import { useEffect } from "react";

import { useEnterpriseActivationRequired } from "@/react-app/domains/cloud/enterprise-activation-gate";
import { startGlobalQueueDrainer } from "./global-queue-drainer";
import { startQueuedDraftPersistence } from "./queued-draft-persistence";

export function GlobalQueueDrainerBridge() {
  useEffect(() => startQueuedDraftPersistence(), []);
  if (useEnterpriseActivationRequired()) return null;
  return <ActivatedGlobalQueueDrainerBridge />;
}

function ActivatedGlobalQueueDrainerBridge() {
  useEffect(() => startGlobalQueueDrainer(), []);
  return null;
}
