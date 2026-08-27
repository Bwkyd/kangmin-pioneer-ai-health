import { DomainError } from "../../kernel/errors.js";
import type { AuditPort } from "../system/audit-ports.js";
import type {
  ActivityStats,
  ExposureRecordView,
  MedicationRecordView,
  PatientSessionView,
  SymptomRecordView,
  UserDetail,
  UserRecordType,
  UserRecordsView,
  UserSummary
} from "./contracts.js";
import type { UserReadRepository } from "./user-admin-ports.js";

/** 列表分页上限（设计 §6：不提供批量导出）。 */
export const USER_LIST_LIMIT_MAX = 100;
const DEFAULT_LIST_LIMIT = 50;
const SESSION_LIMIT = 20;
const RECORD_LIMIT = 50;

/**
 * 脱敏：11 位手机号保留前 3 后 4；纯数字保留后 4；
 * 其他标识保留首尾各 2 位，绝不返回完整手机号或用户名。
 */
export function maskIdentifier(value: string): string {
  if (/^\d{11}$/u.test(value)) {
    return `${value.slice(0, 3)}****${value.slice(-4)}`;
  }
  if (/^\d+$/u.test(value)) {
    return `****${value.slice(-4)}`;
  }
  if (value.length <= 4) {
    return "****";
  }
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

function maskTokenHash(tokenHash: string): string {
  return tokenHash.length <= 8 ? "****" : `${tokenHash.slice(0, 8)}****`;
}

export class UserAdminService {
  constructor(
    private readonly repository: UserReadRepository,
    private readonly audit: AuditPort
  ) {}

  async list(input: {
    limit?: number | undefined;
    activeWithin?: string | undefined;
    query?: string | undefined;
  }): Promise<{ items: UserSummary[]; count: number; limit: number }> {
    const limit = this.listLimit(input.limit);
    const activeWithinDays = this.activeWithinDays(input.activeWithin);
    const rows = await this.repository.listUsers(
      limit,
      activeWithinDays,
      input.query?.trim() || undefined
    );
    return {
      items: rows.map((row) => this.toSummary(row)),
      count: rows.length,
      limit
    };
  }

  async get(id: string): Promise<UserDetail> {
    const row = await this.repository.findUser(id);
    if (row === null) {
      throw new DomainError("resource_not_found", "用户不存在");
    }
    const sessions = await this.repository.listSessions(id, 1);
    const recent = sessions[0] ?? null;
    return {
      ...this.toSummary(row),
      accountStatus: row.accountStatus,
      // 详情视图同样脱敏（评审 B P2：昵称可能含手机号）。
      nickname: maskIdentifier(row.nickname ?? ""),
      recentSession:
        recent === null
          ? null
          : {
              createdAt: recent.createdAt,
              expiresAt: recent.expiresAt,
              active: Date.parse(recent.expiresAt) > Date.now()
            }
    };
  }

  async sessions(
    adminId: string,
    id: string,
    requestId?: string
  ): Promise<{ items: PatientSessionView[] }> {
    await this.requireUser(id);
    const rows = await this.repository.listSessions(id, SESSION_LIMIT);
    await this.audit.record({
      actorKind: "admin",
      actorId: adminId,
      action: "users.sessions.read",
      entityType: "patient",
      entityId: id,
      requestId,
      details: { sessionCount: rows.length }
    });
    return {
      items: rows.map((row) => ({
        sessionId: maskTokenHash(row.tokenHash),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        active: Date.parse(row.expiresAt) > Date.now()
      }))
    };
  }

  async records(
    adminId: string,
    id: string,
    type?: string,
    requestId?: string
  ): Promise<UserRecordsView> {
    await this.requireUser(id);
    const recordType = this.recordTypeOf(type);
    let items: Array<SymptomRecordView | ExposureRecordView | MedicationRecordView>;
    if (recordType === "symptom") {
      const rows = await this.repository.listSymptomRecords(id, RECORD_LIMIT);
      items = rows.map((row) => ({
        id: row.id,
        localDate: row.localDate,
        nasalCongestion: row.nasalCongestion,
        nasalItching: row.nasalItching,
        sneezing: row.sneezing,
        runnyNose: row.runnyNose,
        tnssTotal: row.tnssTotal
      }));
    } else if (recordType === "exposure") {
      const rows = await this.repository.listExposureRecords(id, RECORD_LIMIT);
      items = rows.map((row) => ({
        id: row.id,
        localDate: row.localDate,
        factors: JSON.parse(row.factorsJson) as string[]
      }));
    } else {
      const rows = await this.repository.listMedicationRecords(id, RECORD_LIMIT);
      items = rows.map((row) => ({
        id: row.id,
        localDate: row.localDate,
        medicationName: row.medicationName,
        dosage: row.dosage
      }));
    }
    await this.audit.record({
      actorKind: "admin",
      actorId: adminId,
      action: "users.records.read",
      entityType: "patient",
      entityId: id,
      requestId,
      details: { recordType, itemCount: items.length }
    });
    return { userId: id, type: recordType, items };
  }

  async activity(): Promise<ActivityStats> {
    return this.repository.activity();
  }

  private async requireUser(id: string): Promise<void> {
    const row = await this.repository.findUser(id);
    if (row === null) {
      throw new DomainError("resource_not_found", "用户不存在");
    }
  }

  private toSummary(row: {
    id: string;
    developmentSubject: string | null;
    nickname: string | null;
    registeredAt: string;
    lastActiveAt: string | null;
    sessionCount: number;
    recordCount: number;
  }): UserSummary {
    const identifier =
      row.nickname ?? row.developmentSubject ?? row.id;
    return {
      userId: row.id,
      maskedIdentifier: maskIdentifier(identifier),
      registeredAt: row.registeredAt,
      lastActiveAt: row.lastActiveAt,
      sessionCount: row.sessionCount,
      recordCount: row.recordCount
    };
  }

  private listLimit(value: number | undefined): number {
    if (value === undefined) {
      return DEFAULT_LIST_LIMIT;
    }
    if (!Number.isInteger(value) || value < 1 || value > USER_LIST_LIMIT_MAX) {
      throw new DomainError(
        "validation_failed",
        `limit 必须是 1 到 ${USER_LIST_LIMIT_MAX} 的整数`
      );
    }
    return value;
  }

  /** 支持 "7d"/"30d" 形式；不传返回 undefined（不过滤）。 */
  private activeWithinDays(value: string | undefined): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    const match = /^(\d+)d$/u.exec(value.trim());
    if (match === null) {
      throw new DomainError(
        "validation_failed",
        "activeWithin 必须使用 N 天格式，如 7d"
      );
    }
    return Number(match[1]);
  }

  private recordTypeOf(value: string | undefined): UserRecordType {
    if (value === undefined) {
      return "symptom";
    }
    if (value !== "symptom" && value !== "exposure" && value !== "medication") {
      throw new DomainError(
        "validation_failed",
        "type 必须是 symptom、exposure 或 medication"
      );
    }
    return value;
  }
}
