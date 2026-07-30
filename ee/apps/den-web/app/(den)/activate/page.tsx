import { Suspense } from "react";
import { ActivationScreen } from "../_components/activation-screen";

export default function ActivatePage() {
  return (
    <Suspense fallback={null}>
      <ActivationScreen />
    </Suspense>
  );
}
