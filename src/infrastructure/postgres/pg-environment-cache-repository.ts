import { randomUUID } from "node:crypto";

import { DomainError } from "../../kernel/errors.js";
import type {
  CachedEnvironmentSnapshot,
  EnvironmentCacheRepository,
  EnvironmentSnapshot
} from "../../modules/environment/environment-ports.js";
import { KangminPgDatabase } from "./pg-database.js";

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
 * 环境快照缓存（PostgreSQL 实现）：environment_snapshots 表，
 * 按 (provider, cache_key) 唯一。过期判定在 EnvironmentService，
 * 这里只负责存取；任何存储失败映射为 storage_unavailable。
 */
export class PgEnvironmentCacheRepository implements EnvironmentCacheRepository {
  constructor(private readonly database: KangminPgDatabase) {}

  async find(
    providerId: string,
    cacheKey: string
  ): Promise<CachedEnvironmentSnapshot | null> {
    try {
      const { rows } = await this.database.query<SnapshotRow>(
        `SELECT city, weather_json, air_quality_json, pollen_risk_json,
                observed_at, fetched_at, expires_at, source_label
         FROM environment_snapshots
         WHERE provider = $1 AND cache_key = $2`,
        [providerId, cacheKey]
      );
      const row = rows[0];
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
      await this.database.transaction(async (client) => {
        await this.database.queryIn(
          client,
          `INSERT INTO environment_snapshots(
             id, provider, cache_key, city, weather_json, air_quality_json,
             pollen_risk_json, observed_at, fetched_at, expires_at, source_label
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT(provider, cache_key) DO UPDATE SET
             id = excluded.id,
             city = excluded.city,
             weather_json = excluded.weather_json,
             air_quality_json = excluded.air_quality_json,
             pollen_risk_json = excluded.pollen_risk_json,
             observed_at = excluded.observed_at,
             fetched_at = excluded.fetched_at,
             expires_at = excluded.expires_at,
             source_label = excluded.source_label`,
          [
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
          ]
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
