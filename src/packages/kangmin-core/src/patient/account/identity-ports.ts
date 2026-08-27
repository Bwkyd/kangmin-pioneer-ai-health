/**
 * 身份端口（架构设计 §19：外部端口与降级）。
 *
 * - 患者和管理员使用不同身份空间；
 * - 客户端不得用 Header 或参数指定权威患者 ID；
 * - 生产身份（微信等）未确认前，本地账号适配器是交付形态，
 *   未来通过实现同一端口替换为外部身份提供方。
 */

export type PatientAssurance =
  | "verified_phone"
  | "local_account"
  | "wechat"
  | "development";

export interface PatientIdentity {
  patientId: string;
  assurance: PatientAssurance;
}

export interface PatientIdentityPort {
  /** 从未知令牌解析服务端可信患者身份；无效或过期抛 authentication_required。 */
  resolvePatient(token: string | undefined): Promise<PatientIdentity>;
}

export type AdminRole = "owner" | "admin";

export interface AdminIdentity {
  adminId: string;
  role: AdminRole;
}

export interface AdminIdentityPort {
  resolveAdmin(token: string | undefined): Promise<AdminIdentity>;
}
