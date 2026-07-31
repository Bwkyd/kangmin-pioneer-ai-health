export interface UserSummary {
  userId: string;
  /** 脱敏标识：昵称或掩码后的开发标识/ID；绝不返回完整手机号或用户名。 */
  maskedIdentifier: string;
  registeredAt: string;
  lastActiveAt: string | null;
  sessionCount: number;
  recordCount: number;
}

export interface UserDetail extends UserSummary {
  accountStatus: string;
  nickname: string | null;
  recentSession: {
    createdAt: string;
    expiresAt: string;
    active: boolean;
  } | null;
}

export interface PatientSessionView {
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  active: boolean;
}

export type UserRecordType = "symptom" | "exposure" | "medication";

export interface SymptomRecordView {
  id: string;
  localDate: string;
  nasalCongestion: number;
  nasalItching: number;
  sneezing: number;
  runnyNose: number;
  tnssTotal: number;
}

export interface ExposureRecordView {
  id: string;
  localDate: string;
  factors: string[];
}

export interface MedicationRecordView {
  id: string;
  localDate: string;
  medicationName: string;
  dosage: string | null;
}

export type UserRecordsView = {
  userId: string;
  type: UserRecordType;
  items: Array<SymptomRecordView | ExposureRecordView | MedicationRecordView>;
};

export interface ActivityStats {
  totalUsers: number;
  newUsers7d: number;
  activeUsers7d: number;
  sessionCount: number;
  recordCount: number;
  contentPublishedCount: number;
}
