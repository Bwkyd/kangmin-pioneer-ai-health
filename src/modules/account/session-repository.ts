export interface SessionSnapshot {
  patientId: string;
  expiresAt: string;
}

export interface SaveDevelopmentSessionInput {
  developmentSubject: string;
  newPatientId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface SessionRepository {
  findSession(tokenHash: string): Promise<SessionSnapshot | null>;
  saveDevelopmentSession(
    input: SaveDevelopmentSessionInput
  ): Promise<string>;
}
