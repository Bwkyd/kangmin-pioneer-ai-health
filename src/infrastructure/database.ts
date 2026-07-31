import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DomainError } from "../kernel/errors.js";

export class KangminDatabase {
  readonly connection: DatabaseSync;

  constructor(path: string) {
    try {
      if (path !== ":memory:") {
        mkdirSync(dirname(path), { recursive: true });
      }
      this.connection = new DatabaseSync(path);
      this.connection.exec("PRAGMA foreign_keys = ON");
      this.connection.exec("PRAGMA journal_mode = WAL");
      // 跨进程并发写时等待锁而非立即失败；见 transaction() 的 BUSY 映射。
      this.connection.exec("PRAGMA busy_timeout = 3000");
      this.migrate();
    } catch (error) {
      throw new DomainError(
        "storage_unavailable",
        "健康记录存储不可用",
        { retryable: true, cause: error }
      );
    }
  }

  close(): void {
    this.connection.close();
  }

  transaction<T>(operation: () => T): T {
    this.beginImmediate();
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.connection.exec("ROLLBACK");
      } catch {
        // Preserve the original domain/storage failure.
      }
      if (String(error).includes("database is locked")) {
        // 跨进程瞬时锁争用：可重试，不应归一化为内部错误。
        throw new DomainError(
          "storage_unavailable",
          "健康记录存储正被其他进程占用，请稍后重试",
          { retryable: true, cause: error }
        );
      }
      throw error;
    }
  }

  /**
   * SQLite 文档规定：BEGIN IMMEDIATE 在数据库被占用时立即返回 SQLITE_BUSY，
   * 不经过 busy handler，因此 PRAGMA busy_timeout 对 BEGIN 本身无效。
   * 这里做有限重试（约 3 秒）以容忍跨进程瞬时写锁，超时后由 transaction() 映射为可重试错误。
   */
  private beginImmediate(): void {
    const deadline = Date.now() + 3000;
    for (;;) {
      try {
        this.connection.exec("BEGIN IMMEDIATE");
        return;
      } catch (error) {
        if (
          !String(error).includes("database is locked") ||
          Date.now() >= deadline
        ) {
          throw error;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS patients (
        id TEXT PRIMARY KEY,
        development_subject TEXT UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS patient_sessions (
        token_hash TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL REFERENCES patients(id),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS symptom_records (
        id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL REFERENCES patients(id),
        local_date TEXT NOT NULL,
        nasal_congestion INTEGER NOT NULL CHECK(nasal_congestion BETWEEN 0 AND 3),
        nasal_itching INTEGER NOT NULL CHECK(nasal_itching BETWEEN 0 AND 3),
        sneezing INTEGER NOT NULL CHECK(sneezing BETWEEN 0 AND 3),
        runny_nose INTEGER NOT NULL CHECK(runny_nose BETWEEN 0 AND 3),
        tnss_total INTEGER NOT NULL CHECK(tnss_total BETWEEN 0 AND 12),
        notes TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(patient_id, local_date)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS symptom_records_patient_date
      ON symptom_records(patient_id, local_date DESC);

      CREATE TABLE IF NOT EXISTS idempotency_records (
        patient_id TEXT NOT NULL REFERENCES patients(id),
        command_scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(patient_id, command_scope, idempotency_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS profiles (
        patient_id TEXT PRIMARY KEY REFERENCES patients(id),
        display_name TEXT,
        birth_date TEXT,
        sex TEXT NOT NULL DEFAULT 'unspecified'
          CHECK(sex IN ('female', 'male', 'other', 'unspecified')),
        allergy_history TEXT,
        known_allergies TEXT,
        common_triggers TEXT,
        notes TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS exposure_records (
        id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL REFERENCES patients(id),
        local_date TEXT NOT NULL,
        factors_json TEXT NOT NULL,
        other_description TEXT,
        notes TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(patient_id, local_date)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS exposure_records_patient_date
      ON exposure_records(patient_id, local_date DESC);

      CREATE TABLE IF NOT EXISTS medication_records (
        id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL REFERENCES patients(id),
        local_date TEXT NOT NULL,
        medication_name TEXT NOT NULL,
        dosage TEXT,
        actual_use TEXT,
        notes TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS medication_records_patient_date
      ON medication_records(patient_id, local_date DESC);
    `);
  }
}
