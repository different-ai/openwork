import { VerificationRecoveryScreen } from "../_components/verification-recovery-screen";

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const email = typeof params.email === "string" ? params.email.trim().toLowerCase() : "";

  return <VerificationRecoveryScreen key={email} email={email} />;
}
