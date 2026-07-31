/**
 * 审计端口（数据库设计 §4.6）：发布、下架、知识/方案启停、管理员变更、
 * 敏感患者详情读取和数据请求状态变化必须记录结构固定、脱敏的前后值。
 *
 * audit_events 只追加；details 不得包含健康正文、聊天正文、完整手机号
 * 或任何令牌。
 */

export interface AuditEntry {
  actorKind: "patient" | "admin" | "system";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  entityRevision?: number | undefined;
  requestId?: string | undefined;
  /** 结构固定、脱敏的补充信息（不得含敏感正文）。 */
  details: Record<string, unknown>;
}

export interface AuditPort {
  record(entry: AuditEntry): Promise<void>;
}
