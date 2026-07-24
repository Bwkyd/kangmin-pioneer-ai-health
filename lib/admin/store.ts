export type ContentType = "article" | "video" | "knowledge" | "plan";
export type ContentStatus = "draft" | "published" | "offline" | "indexing" | "index_failed";

type RuntimeEnv = {
  DB?: D1Database;
  MEDIA?: R2Bucket;
  VECTORIZE?: VectorizeIndex;
};

export async function runtime() {
  const { env } = await import("cloudflare:workers");
  const values = env as unknown as RuntimeEnv;
  if (!values.DB) throw new Error("DATABASE_NOT_CONFIGURED");
  await ensureAdminSchema(values.DB);
  return values as RuntimeEnv & { DB: D1Database };
}

let schemaReady: Promise<unknown> | null = null;

function ensureAdminSchema(database: D1Database) {
  schemaReady ??= database.batch(adminSchemaStatements.map((statement) => database.prepare(statement)));
  return schemaReady;
}

export function now() {
  return new Date().toISOString();
}

export function identifier(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function audit(actor: string, action: string, entityType: string, entityId: string, details: unknown = {}) {
  const { DB } = await runtime();
  await DB.prepare("INSERT INTO audit_logs (id, actor, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(identifier("audit"), actor, action, entityType, entityId, JSON.stringify(details), now()).run();
}

export async function executeIdempotent(actor: string, key: string | null, operation: () => Promise<Response>) {
  if (!key) return operation();
  const { DB } = await runtime();
  const existing = await DB.prepare("SELECT response FROM idempotency_keys WHERE key = ? AND actor = ?").bind(key, actor).first<{ response: string }>();
  if (existing) return Response.json(JSON.parse(existing.response));
  const response = await operation();
  if (response.ok) {
    const body = await response.clone().text();
    await DB.prepare("INSERT INTO idempotency_keys (key, actor, response, created_at) VALUES (?, ?, ?, ?)").bind(key, actor, body, now()).run();
  }
  return response;
}

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}
import { adminSchemaStatements } from "./schema-sql";
