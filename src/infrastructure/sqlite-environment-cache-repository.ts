import { randomUUID } from "node:crypto";

import { DomainError } from "../kernel/errors.js";
import { KangminDatabase } from "./database.js";
import type {
  CachedEnvironmentSnapshot,
  EnvironmentCacheRepository,
  EnvironmentSnapshot
} from "../modules/environment/environment-ports.js";

interface SnapshotRow {
  city: string;
  weather_json: string;
  air_quality_json: string;
  pollen_risk_json: string;
  observed_at: string;
  fetched_at: string;
  expires_at: string;
  source_label: string;
}

/**
 * 环境快照缓存（SQLite 实现）：environment_snapshots 表，
 * 按 (provider, cache_key) 唯一。过期判定在 EnvironmentService，
 * 这里只负责存取；任何存储失败映射为 storage_unavailable。
 */
export class SqliteEnvironmentCacheRepository implements EnvironmentCacheRepository {
  constructor(private readonly database: KangminDatabase) {}

  async find(
    providerId: string,
    cacheKey: string
  ): Promise<CachedEnvironmentSnapshot | null> {
    try {
      const row = this.database.connection
        .prepare(
          `SELECT city, weather_json, air_quality_json, pollen_risk_json,
                  observed_at, fetched_at, expires_at, source_label
           FROM environment_snapshots
           WHERE provider = ? AND cache_key = ?`
        )
        .get(providerId, cacheKey) as SnapshotRow | undefined;
      if (row === undefined) {
        return null;
      }
      return {
        city: row.city,
        weatherJson: row.weather_json,
        airQualityJson: row.air_quality_json,
        pollenRiskJson: row.pollen_risk_json,
        observedAt: row.observed_at,
        fetchedAt: row.fetched_at,
        sourceLabel: row.source_label,
        stale: false,
        expiresAt: row.expires_at
      };
    } catch (error) {
      throw new DomainError(
        "storage_unavailable",
        "环境快照缓存不可用",
        { retryable: true, cause: error }
      );
    }
  }

  async save(
    providerId: string,
    snapshot: EnvironmentSnapshot,
    cacheKey: string,
    ttlSeconds: number
  ): Promise<void> {
    try {
      const expiresAt = new Date(
        Date.parse(snapshot.fetchedAt) + ttlSeconds * 1000
      ).toISOString();
      this.database.transaction(() => {
        this.database.connection
          .prepare(
            `INSERT INTO environment_snapshots(
               id, provider, cache_key, city, weather_json, air_quality_json,
               pollen_risk_json, observed_at, fetched_at, expires_at, source_label
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(provider, cache_key) DO UPDATE SET
               id = excluded.id,
               city = excluded.city,
               weather_json = excluded.weather_json,
               air_quality_json = excluded.air_quality_json,
               pollen_risk_json = excluded.pollen_risk_json,
               observed_at = excluded.observed_at,
               fetched_at = excluded.fetched_at,
               expires_at = excluded.expires_at,
               source_label = excluded.source_label`
          )
          .run(
            randomUUID(),
            providerId,
            cacheKey,
            snapshot.city,
            snapshot.weatherJson,
            snapshot.airQualityJson,
            snapshot.pollenRiskJson,
            snapshot.observedAt,
            snapshot.fetchedAt,
            expiresAt,
            snapshot.sourceLabel
          );
      });
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError(
        "storage_unavailable",
        "环境快照缓存不可用",
        { retryable: true, cause: error }
      );
    }
  }
}
