import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
};

export const contentItems = sqliteTable("content_items", {
  id: text("id").primaryKey(),
  type: text("type", { enum: ["article", "video", "knowledge", "plan"] }).notNull(),
  title: text("title").notNull(),
  category: text("category").notNull().default("unclassified"),
  summary: text("summary").notNull().default(""),
  body: text("body").notNull().default(""),
  source: text("source").notNull().default(""),
  status: text("status", { enum: ["draft", "published", "offline", "indexing", "index_failed"] }).notNull().default("draft"),
  version: integer("version").notNull().default(1),
  mediaId: text("media_id"),
  metadata: text("metadata").notNull().default("{}"),
  publishedAt: text("published_at"),
  ...timestamps,
}, (table) => [
  index("content_items_type_status_idx").on(table.type, table.status, table.publishedAt),
  index("content_items_category_idx").on(table.category, table.updatedAt),
]);

export const mediaAssets = sqliteTable("media_assets", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["image", "video", "document"] }).notNull(),
  filename: text("filename").notNull(),
  objectKey: text("object_key").notNull().unique(),
  contentType: text("content_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  status: text("status", { enum: ["ready", "offline"] }).notNull().default("ready"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const planSteps = sqliteTable("plan_steps", {
  id: text("id").primaryKey(),
  planId: text("plan_id").notNull().references(() => contentItems.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  title: text("title").notNull(),
  instruction: text("instruction").notNull(),
  mediaId: text("media_id").references(() => mediaAssets.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("plan_steps_plan_position_idx").on(table.planId, table.position)]);

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  contentId: text("content_id").notNull().references(() => contentItems.id),
  title: text("title").notNull(),
  body: text("body").notNull(),
  publishedAt: text("published_at").notNull(),
}, (table) => [uniqueIndex("notifications_content_idx").on(table.contentId)]);

export const notificationReads = sqliteTable("notification_reads", {
  notificationId: text("notification_id").notNull().references(() => notifications.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  readAt: text("read_at").notNull(),
}, (table) => [uniqueIndex("notification_reads_user_idx").on(table.notificationId, table.userId)]);

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  details: text("details").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("audit_logs_entity_idx").on(table.entityType, table.entityId, table.createdAt)]);

export const idempotencyKeys = sqliteTable("idempotency_keys", {
  key: text("key").primaryKey(),
  actor: text("actor").notNull(),
  response: text("response").notNull(),
  createdAt: text("created_at").notNull(),
});
