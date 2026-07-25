export const adminSchemaStatements = [
  "CREATE TABLE IF NOT EXISTS content_items (id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, category TEXT DEFAULT 'unclassified' NOT NULL, summary TEXT DEFAULT '' NOT NULL, body TEXT DEFAULT '' NOT NULL, source TEXT DEFAULT '' NOT NULL, status TEXT DEFAULT 'draft' NOT NULL, version INTEGER DEFAULT 1 NOT NULL, media_id TEXT, metadata TEXT DEFAULT '{}' NOT NULL, published_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS content_items_type_status_idx ON content_items (type, status, published_at)",
  "CREATE INDEX IF NOT EXISTS content_items_category_idx ON content_items (category, updated_at)",
  "CREATE TABLE IF NOT EXISTS media_assets (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL, byte_size INTEGER NOT NULL, status TEXT DEFAULT 'ready' NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY NOT NULL, content_id TEXT NOT NULL UNIQUE REFERENCES content_items(id), title TEXT NOT NULL, body TEXT NOT NULL, published_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS notification_reads (notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE, user_id TEXT NOT NULL, read_at TEXT NOT NULL, UNIQUE(notification_id, user_id))",
  "CREATE TABLE IF NOT EXISTS plan_steps (id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE, position INTEGER NOT NULL, title TEXT NOT NULL, instruction TEXT NOT NULL, media_id TEXT REFERENCES media_assets(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(plan_id, position))",
  "CREATE TABLE IF NOT EXISTS knowledge_chunks (id TEXT PRIMARY KEY NOT NULL, knowledge_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE, source_version INTEGER NOT NULL, position INTEGER NOT NULL, chunk_text TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(knowledge_id, source_version, position))",
  "CREATE INDEX IF NOT EXISTS knowledge_chunks_source_version_idx ON knowledge_chunks (knowledge_id, source_version)",
  "CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, details TEXT DEFAULT '{}' NOT NULL, created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at)",
  "CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY NOT NULL, actor TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL)",
] as const;
