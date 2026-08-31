/** @jsxImportSource react */
import { useEffect } from "react";

import { startGlobalQueueDrainer } from "./global-queue-drainer";

export function GlobalQueueDrainerBridge() {
  useEffect(() => startGlobalQueueDrainer(), []);
  return null;
}
