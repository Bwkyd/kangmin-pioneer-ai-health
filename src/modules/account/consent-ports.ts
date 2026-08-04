/**
 * consent 门禁窄端口（issue-155）：record 写入前置校验与 Agent 会话保存
 * 绑定共用。组合根装配实现（R1 门禁注入先例：构造传入），领域服务只依赖
 * 本端口，不直接触碰 account 仓储。
 */

import type {
  ConsentDecision,
  ConsentRecord,
  ConsentType
} from "./account-repository.js";

export interface ConsentGatePort {
  /** 该患者某类型最新决策；无记录返回 null（fail-closed 判定在调用方）。 */
  latestDecision(
    patientId: string,
    consentType: ConsentType
  ): Promise<ConsentDecision | null>;
  /** 追加一条 granted 决策（如绑定时补记 Agent 会话保存授权），返回含真实 id 的记录。 */
  appendGranted(input: {
    patientId: string;
    consentType: ConsentType;
    requestId: string;
  }): Promise<ConsentRecord>;
}
