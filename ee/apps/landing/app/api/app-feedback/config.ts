const DEFAULT_INTERNAL_FEEDBACK_EMAIL = "team@openworklabs.com";
const FEEDBACK_EMAIL_TEMPLATE_NAME = "Feedback email v2";

type FeedbackEmailConfig = {
  internalEmail: string;
  templateName: string;
  transactionalId: string;
};

export function getFeedbackEmailConfig(
  env: Record<string, string | undefined>,
): FeedbackEmailConfig {
  return {
    internalEmail:
      env.LOOPS_INTERNAL_FEEDBACK_EMAIL?.trim() ||
      DEFAULT_INTERNAL_FEEDBACK_EMAIL,
    templateName: FEEDBACK_EMAIL_TEMPLATE_NAME,
    transactionalId: env.LOOPS_TRANSACTIONAL_ID_APP_FEEDBACK?.trim() || "",
  };
}
