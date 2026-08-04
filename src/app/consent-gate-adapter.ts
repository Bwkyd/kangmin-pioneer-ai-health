import type {
  AccountRepository,
  ConsentDecision,
  ConsentRecord,
  ConsentType
} from "../modules/account/account-repository.js";
import { CURRENT_POLICY_VERSION } from "../modules/account/account-service.js";
import type { ConsentGatePort } from "../modules/account/consent-ports.js";

/**
 * consent 门禁适配器（issue-155）：RecordService 写入前置校验与
 * ConversationService 绑定保存共用的窄端口实现，底层走 account 仓储。
 * 不经过 AccountService.consentUpdate（它要求本地账号存在；开发会话患者
 * 只有 patients 行，同样允许落授权记录——与生产语义一致地 fail-closed）。
 */
export class ConsentGateAdapter implements ConsentGatePort {
  constructor(private readonly accounts: AccountRepository) {}

  async latestDecision(
    patientId: string,
    consentType: ConsentType
  ): Promise<ConsentDecision | null> {
    const latest = await this.accounts.findLatestConsent(patientId, consentType);
    return latest === null ? null : latest.decision;
  }

  appendGranted(input: {
    patientId: string;
    consentType: ConsentType;
    requestId: string;
  }): Promise<ConsentRecord> {
    return this.accounts.appendConsent({
      patientId: input.patientId,
      consentType: input.consentType,
      decision: "granted",
      policyVersion: CURRENT_POLICY_VERSION,
      requestId: input.requestId,
      createdAt: new Date().toISOString()
    });
  }
}
