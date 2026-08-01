export interface UserListRow {
  id: string;
  developmentSubject: string | null;
  nickname: string | null;
  accountStatus: string;
  registeredAt: string;
  lastActiveAt: string | null;
  sessionCount: number;
  recordCount: number;
}

export interface PatientSessionRow {
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface SymptomProjectionRow {
  id: string;
  localDate: string;
  nasalCongestion: number;
  nasalItching: number;
  sneezing: number;
  runnyNose: number;
  tnssTotal: number;
}

export interface ExposureProjectionRow {
  id: string;
  localDate: string;
  factorsJson: string;
}

export interface MedicationProjectionRow {
  id: string;
  localDate: string;
  /** 用药正文已加密（0005），管理端组合根不注入加密端口：恒为 null。 */
  medicationName: string | null;
  dosage: string | null;
}

export interface ActivitySource {
  totalUsers: number;
  newUsers7d: number;
  activeUsers7d: number;
  sessionCount: number;
  recordCount: number;
  contentPublishedCount: number;
}

export interface UserReadRepository {
  /** 只读投影：绝不返回完整手机号、会话令牌或健康正文。 */
  listUsers(
    limit: number,
    activeWithinDays?: number,
    query?: string
  ): Promise<UserListRow[]>;
  findUser(id: string): Promise<UserListRow | null>;
  listSessions(userId: string, limit: number): Promise<PatientSessionRow[]>;
  listSymptomRecords(userId: string, limit: number): Promise<SymptomProjectionRow[]>;
  listExposureRecords(userId: string, limit: number): Promise<ExposureProjectionRow[]>;
  listMedicationRecords(userId: string, limit: number): Promise<MedicationProjectionRow[]>;
  activity(): Promise<ActivitySource>;
}
