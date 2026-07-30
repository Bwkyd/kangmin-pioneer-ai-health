import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  clinicalCandidateKind: text("clinical_candidate_kind"),
  clinicalChangeDiff: text("clinical_change_diff").notNull().default(""),
  clinicalReviewStatus: text("clinical_review_status", { enum: ["pending_review", "approved", "rejected"] }).notNull().default("pending_review"),
  clinicalReviewer: text("clinical_reviewer"),
  clinicalReviewedAt: text("clinical_reviewed_at"),
  publishedAt: text("published_at"),
  writeToken: text("write_token"),
  ...timestamps,
}, (table) => [
  index("content_items_type_status_idx").on(table.type, table.status, table.publishedAt),
  index("content_items_category_idx").on(table.category, table.updatedAt),
]);

export const clinicalApprovals = sqliteTable("clinical_approvals", {
  contentId: text("content_id").primaryKey().references(() => contentItems.id, { onDelete: "cascade" }),
  contentVersion: integer("content_version").notNull(),
  approver: text("approver").notNull(),
  approvedAt: text("approved_at").notNull(),
});

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

export const knowledgeChunks = sqliteTable("knowledge_chunks", {
  id: text("id").primaryKey(),
  knowledgeId: text("knowledge_id").notNull().references(() => contentItems.id, { onDelete: "cascade" }),
  sourceVersion: integer("source_version").notNull(),
  position: integer("position").notNull(),
  chunkText: text("chunk_text").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("knowledge_chunks_source_position_idx").on(table.knowledgeId, table.sourceVersion, table.position),
  index("knowledge_chunks_source_version_idx").on(table.knowledgeId, table.sourceVersion),
]);

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
  key: text("key").notNull(),
  actor: text("actor").notNull(),
  response: text("response").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.key, table.actor] })]);

export const healthProfiles = sqliteTable("health_profiles", {
  userId: text("user_id").primaryKey(),
  basicInfo: text("basic_info").notNull(),
  allergyHistory: text("allergy_history").notNull(),
  commonTriggers: text("common_triggers").notNull().default("[]"),
  version: integer("version").notNull().default(1),
  ...timestamps,
});

export const medicationRecords = sqliteTable("medication_records", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  takenAt: text("taken_at").notNull(),
  medicationName: text("medication_name").notNull(),
  dosageStatus: text("dosage_status", { enum: ["known", "unknown"] }).notNull(),
  dosageValue: text("dosage_value"),
  dosageUnit: text("dosage_unit"),
  actualUseStatus: text("actual_use_status", { enum: ["known", "unknown"] }).notNull(),
  actualUseDescription: text("actual_use_description"),
  version: integer("version").notNull().default(1),
  ...timestamps,
}, (table) => [
  index("medication_records_user_time_idx").on(table.userId, table.takenAt, table.id),
]);

export const symptomRecords = sqliteTable("symptom_records", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  symptomDate: text("symptom_date").notNull(),
  sneezing: integer("sneezing").notNull(),
  rhinorrhea: integer("rhinorrhea").notNull(),
  congestion: integer("congestion").notNull(),
  itching: integer("itching").notNull(),
  totalScore: integer("total_score").notNull(),
  version: integer("version").notNull().default(1),
  ...timestamps,
}, (table) => [
  uniqueIndex("symptom_records_user_date_idx").on(table.userId, table.symptomDate),
]);

export const allergenExposureRecords = sqliteTable("allergen_exposure_records", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  exposureDate: text("exposure_date").notNull(),
  otherDescription: text("other_description"),
  note: text("note"),
  mutationId: text("mutation_id").notNull(),
  version: integer("version").notNull().default(1),
  ...timestamps,
}, (table) => [
  uniqueIndex("allergen_exposure_records_user_date_idx").on(table.userId, table.exposureDate),
]);

export const allergenExposureSelections = sqliteTable("allergen_exposure_selections", {
  exposureId: text("exposure_id").notNull().references(() => allergenExposureRecords.id, { onDelete: "cascade" }),
  groupCode: text("group_code").notNull(),
  optionCode: text("option_code").notNull(),
}, (table) => [
  primaryKey({ columns: [table.exposureId, table.optionCode] }),
  index("allergen_exposure_selections_option_idx").on(table.optionCode, table.exposureId),
]);

export const healthRecordIdempotency = sqliteTable("health_record_idempotency", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  scope: text("scope").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  state: text("state", { enum: ["pending", "completed"] }).notNull(),
  response: text("response"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  uniqueIndex("health_record_idempotency_user_scope_key_idx").on(table.userId, table.scope, table.key),
]);
