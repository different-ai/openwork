import { Suspense } from "react";
import { ResetPasswordScreen } from "../_components/reset-password-screen";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordScreen />
    </Suspense>
  );
}
