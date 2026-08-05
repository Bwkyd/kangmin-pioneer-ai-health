import { command } from "./command-client";

type ConsentItem = {
  consentType: string;
  decision: "granted" | "withdrawn";
};

type ConsentState = {
  items: ConsentItem[];
};

type PrivacyPolicy = {
  policyVersion: string;
  statement: string;
};

export type PreviewConsent = {
  granted: boolean;
  policyVersion: string;
  statement: string;
};

/**
 * 首次进入先建立 HttpOnly 预览会话，再读取真实 consent 状态与当前政策
 * 版本。command 客户端会在 authentication_required 时自动建立会话。
 */
export async function loadPreviewConsent(): Promise<PreviewConsent> {
  const [state, privacy] = await Promise.all([
    command<ConsentState>("account consent show"),
    command<PrivacyPolicy>("account privacy")
  ]);
  const healthData = state.items.find(
    (item) => item.consentType === "health_data"
  );
  return {
    granted: healthData?.decision === "granted",
    policyVersion: privacy.policyVersion,
    statement: privacy.statement
  };
}

/** 明确点击后才追加 granted 决策；不自动授权、不直接写数据库。 */
export async function grantPreviewConsent(
  policyVersion: string
): Promise<void> {
  await command("account consent update", {
    consentType: "health_data",
    decision: "granted",
    policyVersion,
    requestId: crypto.randomUUID()
  });
}
