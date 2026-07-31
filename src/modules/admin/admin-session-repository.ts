export interface AdminSessionRepository {
  find(tokenHash: string): Promise<{ adminId: string; expiresAt: string } | null>;
  save(input: {
    subject: string;
    newAdminId: string;
    tokenHash: string;
    expiresAt: string;
    createdAt: string;
  }): Promise<string>;
}
