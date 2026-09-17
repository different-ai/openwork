const MESSAGES = Object.freeze({
  en: Object.freeze({
    signInPolicy: "Sign in to verify your organization’s link policy",
    blockedPolicy: "This link is blocked by your organization’s policy",
    policyServiceUnavailable: "OpenWork couldn’t reach its link-policy service",
    defaultBrowserUnavailable: "OpenWork couldn’t open this link in your default browser",
    signIn: "Sign in", cancel: "Cancel", retry: "Retry",
  }),
  ja: Object.freeze({
    signInPolicy: "組織のリンクポリシーを確認するにはサインインしてください",
    blockedPolicy: "このリンクは組織のポリシーによってブロックされています",
    policyServiceUnavailable: "OpenWork はリンクポリシーサービスに接続できませんでした",
    defaultBrowserUnavailable: "OpenWork はデフォルトのブラウザでこのリンクを開けませんでした",
    signIn: "サインイン", cancel: "キャンセル", retry: "再試行",
  }),
  zh: Object.freeze({
    signInPolicy: "登录以验证贵组织的链接策略",
    blockedPolicy: "此链接已被贵组织的策略阻止",
    policyServiceUnavailable: "OpenWork 无法连接到链接策略服务",
    defaultBrowserUnavailable: "OpenWork 无法在默认浏览器中打开此链接",
    signIn: "登录", cancel: "取消", retry: "重试",
  }),
  vi: Object.freeze({
    signInPolicy: "Đăng nhập để xác minh chính sách liên kết của tổ chức",
    blockedPolicy: "Liên kết này bị chính sách của tổ chức chặn",
    policyServiceUnavailable: "OpenWork không thể kết nối tới dịch vụ chính sách liên kết",
    defaultBrowserUnavailable: "OpenWork không thể mở liên kết này trong trình duyệt mặc định",
    signIn: "Đăng nhập", cancel: "Hủy", retry: "Thử lại",
  }),
  "pt-BR": Object.freeze({
    signInPolicy: "Entre para verificar a política de links da sua organização",
    blockedPolicy: "Este link foi bloqueado pela política da sua organização",
    policyServiceUnavailable: "O OpenWork não conseguiu acessar o serviço de política de links",
    defaultBrowserUnavailable: "O OpenWork não conseguiu abrir este link no navegador padrão",
    signIn: "Entrar", cancel: "Cancelar", retry: "Tentar novamente",
  }),
  th: Object.freeze({
    signInPolicy: "ลงชื่อเข้าใช้เพื่อยืนยันนโยบายลิงก์ขององค์กร",
    blockedPolicy: "ลิงก์นี้ถูกบล็อกโดยนโยบายขององค์กร",
    policyServiceUnavailable: "OpenWork ไม่สามารถเชื่อมต่อบริการนโยบายลิงก์ได้",
    defaultBrowserUnavailable: "OpenWork ไม่สามารถเปิดลิงก์นี้ในเบราว์เซอร์เริ่มต้นได้",
    signIn: "ลงชื่อเข้าใช้", cancel: "ยกเลิก", retry: "ลองอีกครั้ง",
  }),
  fr: Object.freeze({
    signInPolicy: "Connectez-vous pour vérifier la politique de liens de votre organisation",
    blockedPolicy: "Ce lien est bloqué par la politique de votre organisation",
    policyServiceUnavailable: "OpenWork n’a pas pu joindre son service de politique de liens",
    defaultBrowserUnavailable: "OpenWork n’a pas pu ouvrir ce lien dans votre navigateur par défaut",
    signIn: "Se connecter", cancel: "Annuler", retry: "Réessayer",
  }),
  ca: Object.freeze({
    signInPolicy: "Inicieu la sessió per verificar la política d’enllaços de la vostra organització",
    blockedPolicy: "Aquest enllaç està bloquejat per la política de la vostra organització",
    policyServiceUnavailable: "OpenWork no ha pogut contactar amb el servei de política d’enllaços",
    defaultBrowserUnavailable: "OpenWork no ha pogut obrir aquest enllaç al navegador predeterminat",
    signIn: "Inicia la sessió", cancel: "Cancel·la", retry: "Torna-ho a provar",
  }),
  es: Object.freeze({
    signInPolicy: "Inicia sesión para verificar la política de enlaces de tu organización",
    blockedPolicy: "Este enlace está bloqueado por la política de tu organización",
    policyServiceUnavailable: "OpenWork no pudo comunicarse con el servicio de políticas de enlaces",
    defaultBrowserUnavailable: "OpenWork no pudo abrir este enlace en tu navegador predeterminado",
    signIn: "Iniciar sesión", cancel: "Cancelar", retry: "Reintentar",
  }),
  ru: Object.freeze({
    signInPolicy: "Войдите, чтобы проверить политику ссылок вашей организации",
    blockedPolicy: "Эта ссылка заблокирована политикой вашей организации",
    policyServiceUnavailable: "OpenWork не удалось связаться со службой политики ссылок",
    defaultBrowserUnavailable: "OpenWork не удалось открыть эту ссылку в браузере по умолчанию",
    signIn: "Войти", cancel: "Отмена", retry: "Повторить",
  }),
});

export const LINK_POLICY_LOCALES = Object.freeze(Object.keys(MESSAGES));

export function linkPolicyMessages(locale) {
  if (typeof locale !== "string") return MESSAGES.en;
  const normalized = locale.trim();
  if (normalized === "pt-BR") return MESSAGES[normalized];
  const language = normalized.split("-")[0]?.toLowerCase();
  return MESSAGES[language] ?? MESSAGES.en;
}
