/**
 * PostgreSQL 版本化迁移。
 *
 * 生产从空库初始化，因此基线 0001 直接建立 SQLite 迁移链推进到
 * 0013 后的最终表结构（35 张表，由 SQLite schema_migrations 全量
 * 应用后转译：去掉 STRICT、其余 CHECK/外键/部分唯一索引保持等价）。
 * SQLite 特有的明文→加密回填迁移在 PostgreSQL 不存在（没有旧明文数据）。
 *
 * 语义约定与 SQLite 一致：
 * - 时间戳统一 TEXT（ISO 8601 字符串），比较语义与既有查询一致；
 * - 布尔以 INTEGER 0/1 存储；
 * - JSON 载荷以 TEXT 存储，不启用 jsonb 自动解析。
 */

import {
  CONTENT_CATEGORY_REGISTRY,
  VIDEO_TRUTH_ASSIGNMENTS
} from "@kangmin/core/operations/admin/content-category-registry";

const sqlText = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const categorySeedValues = CONTENT_CATEGORY_REGISTRY.map((category) =>
  `(${sqlText(category.id)}, ${sqlText(category.kind)}, ${category.parentId === null ? "NULL" : sqlText(category.parentId)}, ${sqlText(category.name)}, ${sqlText(category.audience)}, ${sqlText(category.nodeType)}, ${category.selectable ? 1 : 0}, ${category.displayOrder}, 'active', 1, '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`
).join(",\n");
const videoAssignmentValues = VIDEO_TRUTH_ASSIGNMENTS.flatMap((assignment) =>
  assignment.categoryIds.map((categoryId) =>
    `(${sqlText(assignment.title)}, ${sqlText(categoryId)})`
  )
).join(",\n");

export interface PgMigration {
  version: string;
  statements: string[];
}

export const PG_MIGRATIONS: PgMigration[] = [
  {
    version: "0001_baseline",
    statements: [
      `CREATE TABLE patients (
        id TEXT PRIMARY KEY,
        development_subject TEXT UNIQUE,
        created_at TEXT NOT NULL
      )`,

      `CREATE TABLE patient_sessions (
        token_hash TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL REFERENCES patients(id),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        client_kind TEXT NOT NULL DEFAULT 'development'
          CHECK(client_kind IN ('development', 'mini_program', 'cli')),
        revoked_at TEXT
      )`,

      `CREATE TABLE symptom_records (
        id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL REFERENCES patients(id),
        local_date TEXT NOT NULL,
        nasal_congestion INTEGER NOT NULL CHECK(nasal_congestion BETWEEN 0 AND 3),
        nasal_itching INTEGER NOT NULL CHECK(nasal_itching BETWEEN 0 AND 3),
        sneezing INTEGER NOT NULL CHECK(sneezing BETWEEN 0 AND 3),
        runny_nose INTEGER NOT NULL CHECK(runny_nose BETWEEN 0 AND 3),
        tnss_total INTEGER NOT NULL CHECK(tnss_total BETWEEN 0 AND 12),
        notes_encrypted TEXT,
        encryption_key_version TEXT,
        deleted_at TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX symptom_records_patient_date
        ON symptom_records(patient_id, local_date DESC)`,
      `CREATE UNIQUE INDEX symptom_records_patient_date_active
        ON symptom_records(patient_id, local_date) WHERE deleted_at IS NULL`,

      `CREATE TABLE idempotency_records (
        patient_id TEXT NOT NULL REFERENCES patients(id),
        command_scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(patient_id, command_scope, idempotency_key)
      )`,

      `CREATE TABLE profiles (
        patient_id TEXT PRIMARY KEY REFERENCES patients(id),
        display_name_encrypted TEXT,
        birth_date TEXT,
        sex TEXT NOT NULL DEFAULT 'unspecified'
          CHECK(sex IN ('female', 'male', 'other', 'unspecified')),
        allergy_history_encrypted TEXT,
        known_allergies_encrypted TEXT,
        common_triggers_encrypted TEXT,
        notes_encrypted TEXT,
        encryption_key_version TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,

      `CREATE TABLE exposure_records (
        id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL REFERENCES patients(id),
        local_date TEXT NOT NULL,
        factors_json TEXT NOT NULL,
        other_description_encrypted TEXT,
        notes_encrypted TEXT,
        encryption_key_version TEXT,
        deleted_at TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX exposure_records_patient_date
        ON exposure_records(patient_id, local_date DESC)`,
      `CREATE UNIQUE INDEX exposure_records_patient_date_active
        ON exposure_records(patient_id, local_date) WHERE deleted_at IS NULL`,

      `CREATE TABLE medication_records (
        id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL REFERENCES patients(id),
        local_date TEXT NOT NULL,
        medication_name_encrypted TEXT NOT NULL,
        dosage_encrypted TEXT,
        actual_use_encrypted TEXT,
        notes_encrypted TEXT,
        encryption_key_version TEXT,
        deleted_at TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX medication_records_patient_date
        ON medication_records(patient_id, local_date DESC)`,

      `CREATE TABLE patient_record_versions (
        record_type TEXT NOT NULL
          CHECK(record_type IN ('symptom', 'profile', 'exposure', 'medication')),
        record_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        operation TEXT NOT NULL CHECK(operation IN ('create', 'update', 'delete')),
        encrypted_snapshot TEXT NOT NULL,
        encryption_key_version TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK(actor_kind IN ('patient', 'system')),
        actor_id TEXT,
        request_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(record_type, record_id, revision)
      )`,

      `CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        actor_kind TEXT NOT NULL CHECK(actor_kind IN ('patient', 'admin', 'system')),
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        entity_revision INTEGER,
        request_id TEXT,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX audit_events_entity
        ON audit_events(entity_type, entity_id, created_at DESC)`,
      `CREATE INDEX audit_events_actor
        ON audit_events(actor_kind, actor_id, created_at DESC)`,

      `CREATE TABLE patient_accounts (
        patient_id TEXT PRIMARY KEY REFERENCES patients(id),
        username_hash TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'deactivated', 'deletion_pending')),
        nickname TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        last_active_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        username_masked TEXT NOT NULL DEFAULT ''
      )`,

      `CREATE TABLE patient_consents (
        patient_id TEXT NOT NULL REFERENCES patients(id),
        consent_type TEXT NOT NULL
          CHECK(consent_type IN ('privacy', 'medical_boundary')),
        sequence INTEGER NOT NULL CHECK(sequence >= 1),
        decision TEXT NOT NULL
          CHECK(decision IN ('granted', 'withdrawn')),
        policy_version TEXT NOT NULL,
        request_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(patient_id, consent_type, sequence)
      )`,
      `CREATE INDEX patient_consents_latest
        ON patient_consents(patient_id, consent_type, sequence DESC)`,

      `CREATE TABLE admin_accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner', 'admin')),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'disabled')),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,

      `CREATE TABLE admin_sessions (
        token_hash TEXT PRIMARY KEY,
        admin_id TEXT NOT NULL REFERENCES admin_accounts(id),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_reason TEXT
      )`,
      `CREATE INDEX admin_sessions_admin
        ON admin_sessions(admin_id)`,

      `CREATE TABLE admin_idempotency (
        admin_id TEXT NOT NULL REFERENCES admin_accounts(id),
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(admin_id, scope, idempotency_key)
      )`,

      `CREATE TABLE admins (
        id TEXT PRIMARY KEY,
        development_subject TEXT UNIQUE,
        role TEXT NOT NULL CHECK(role IN ('owner', 'admin')),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        created_at TEXT NOT NULL
      )`,

      `CREATE TABLE content_categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('article', 'video', 'message', 'general')),
        description TEXT,
        display_order INTEGER NOT NULL DEFAULT 0 CHECK(display_order >= 0),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX content_categories_kind_order
        ON content_categories(kind, display_order, name)`,

      `CREATE TABLE content_resource_media (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('image', 'video', 'word', 'pdf', 'markdown')),
        filename TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        mime_type TEXT,
        sha256 TEXT,
        status TEXT NOT NULL DEFAULT 'processing'
          CHECK(status IN ('processing', 'ready', 'failed', 'disabled')),
        failure_reason TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX content_resource_media_created
        ON content_resource_media(created_at DESC)`,

      `CREATE TABLE content_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('article', 'video')),
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        body TEXT,
        source TEXT NOT NULL,
        cover_url TEXT,
        media_url TEXT,
        status TEXT NOT NULL
          CHECK(status IN ('draft', 'review', 'published', 'unpublished', 'failed')),
        patient_visible INTEGER NOT NULL CHECK(patient_visible IN (0, 1)),
        version_valid INTEGER NOT NULL CHECK(version_valid IN (0, 1)),
        media_available INTEGER NOT NULL CHECK(media_available IN (0, 1)),
        published_at TEXT,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
        created_by TEXT,
        media_id TEXT REFERENCES content_resource_media(id),
        cover_media_id TEXT REFERENCES content_resource_media(id),
        instructions TEXT,
        precautions TEXT,
        disclaimer TEXT,
        method_tags TEXT,
        display_order INTEGER NOT NULL DEFAULT 0 CHECK(display_order >= 0)
      )`,
      `CREATE INDEX content_items_public_kind_updated
        ON content_items(kind, status, patient_visible, updated_at DESC)`,

      `CREATE TABLE content_messages (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        summary TEXT,
        category_id TEXT REFERENCES content_categories(id),
        status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'unpublished')),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        published_at TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX content_messages_status_created
        ON content_messages(status, created_at DESC)`,

      `CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL REFERENCES patients(id),
        status TEXT NOT NULL
          CHECK(status IN ('awaiting_answer', 'safety_blocked', 'completed')),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        session_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX agent_sessions_patient_updated
        ON agent_sessions(patient_id, updated_at DESC)`,

      `CREATE TABLE agent_care_plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
        enabled_revision INTEGER,
        published_revision INTEGER,
        revision INTEGER NOT NULL CHECK(revision >= 1)
      )`,

      `CREATE TABLE agent_care_plan_revisions (
        plan_id TEXT NOT NULL REFERENCES agent_care_plans(id),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        name TEXT NOT NULL,
        summary TEXT,
        steps_json TEXT,
        disclaimer TEXT,
        created_by_admin_id TEXT,
        PRIMARY KEY(plan_id, revision)
      )`,

      `CREATE TABLE environment_snapshots (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        city TEXT NOT NULL,
        weather_json TEXT NOT NULL,
        air_quality_json TEXT NOT NULL,
        pollen_risk_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        source_label TEXT NOT NULL,
        UNIQUE(provider, cache_key)
      )`,

      `CREATE TABLE agent_conversations (
        id TEXT PRIMARY KEY,
        patient_id TEXT REFERENCES patients(id),
        state TEXT NOT NULL
          CHECK(state IN ('active', 'completed', 'abandoned')),
        save_consent_id TEXT,
        rule_package_version TEXT NOT NULL,
        rule_package_hash TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),
        closed_at TEXT,
        retention_until TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX agent_conversations_patient_updated
        ON agent_conversations(patient_id, updated_at DESC)`,

      `CREATE TABLE agent_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_conversations(id),
        sequence INTEGER NOT NULL CHECK(sequence >= 1),
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system_notice')),
        decision_id TEXT,
        content_encrypted TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        encryption_key_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      )`,

      `CREATE TABLE agent_confirmed_answers (
        session_id TEXT NOT NULL REFERENCES agent_conversations(id),
        field_code TEXT NOT NULL,
        value TEXT NOT NULL
          CHECK(value IN ('missing', 'unknown', 'yes', 'no', 'value')),
        fact_value TEXT,
        source TEXT NOT NULL,
        rule_package_version TEXT NOT NULL,
        rule_package_hash TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        confirmed_at TEXT NOT NULL,
        PRIMARY KEY(session_id, field_code)
      )`,

      `CREATE TABLE agent_candidates (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_conversations(id),
        field_code TEXT NOT NULL,
        proposed_value_encrypted TEXT,
        encryption_key_version TEXT NOT NULL,
        source_message_id TEXT,
        state TEXT NOT NULL
          CHECK(state IN ('proposed', 'adopted', 'ignored', 'expired')),
        created_at TEXT NOT NULL,
        decided_at TEXT
      )`,

      `CREATE TABLE agent_decisions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_conversations(id),
        decision_sequence INTEGER NOT NULL CHECK(decision_sequence >= 1),
        session_revision INTEGER NOT NULL CHECK(session_revision >= 1),
        input_snapshot_encrypted TEXT NOT NULL,
        input_snapshot_hash TEXT NOT NULL,
        outcome TEXT NOT NULL
          CHECK(outcome IN ('blocked', 'need_more_information', 'non_applicable',
                            'conflict', 'no_match', 'classified')),
        stage TEXT NOT NULL
          CHECK(stage IN ('safety', 'applicability', 'severity',
                          'syndrome', 'plan_safety', 'completed')),
        severity_code TEXT,
        syndrome_code TEXT,
        next_questions_json TEXT NOT NULL,
        matched_rule_ids_json TEXT NOT NULL,
        rule_package_version TEXT NOT NULL,
        rule_package_hash TEXT NOT NULL,
        plan_id TEXT,
        plan_revision INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, decision_sequence)
      )`,

      `CREATE TABLE agent_feedback (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_conversations(id),
        decision_id TEXT,
        rating TEXT NOT NULL CHECK(rating IN ('helpful', 'unhelpful')),
        reason_encrypted TEXT,
        encryption_key_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,

      `CREATE TABLE agent_knowledge_items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT,
        description TEXT,
        source_media_id TEXT REFERENCES content_resource_media(id),
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        mime_type TEXT,
        sha256 TEXT,
        status TEXT NOT NULL CHECK(status IN ('draft', 'processing', 'indexed', 'enabled', 'disabled', 'index_failed')),
        parse_error TEXT,
        chunk_count INTEGER NOT NULL DEFAULT 0 CHECK(chunk_count >= 0),
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX agent_knowledge_items_status
        ON agent_knowledge_items(status)`,

      `CREATE TABLE agent_knowledge_chunks (
        knowledge_id TEXT NOT NULL REFERENCES agent_knowledge_items(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
        chunk_text TEXT NOT NULL,
        PRIMARY KEY(knowledge_id, chunk_index)
      )`,

      `CREATE TABLE agent_plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        syndrome TEXT NOT NULL,
        method TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        precautions TEXT NOT NULL,
        risks TEXT NOT NULL,
        contraindications TEXT NOT NULL,
        applicable_age TEXT,
        video_resource_id TEXT REFERENCES content_items(id),
        display_order INTEGER NOT NULL DEFAULT 0 CHECK(display_order >= 0),
        status TEXT NOT NULL CHECK(status IN ('draft', 'enabled', 'disabled')),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX agent_plans_syndrome_status
        ON agent_plans(syndrome, status)`,

      `CREATE TABLE agent_model_config (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        provider TEXT NOT NULL DEFAULT 'openai-compatible',
        model_name TEXT NOT NULL DEFAULT '',
        timeout_seconds INTEGER NOT NULL DEFAULT 30 CHECK(timeout_seconds BETWEEN 1 AND 300),
        max_output_tokens INTEGER NOT NULL DEFAULT 1024 CHECK(max_output_tokens BETWEEN 128 AND 32768),
        knowledge_retrieval_enabled INTEGER NOT NULL DEFAULT 0 CHECK(knowledge_retrieval_enabled IN (0, 1)),
        retrieval_count INTEGER NOT NULL DEFAULT 3 CHECK(retrieval_count BETWEEN 1 AND 20),
        explanation_enabled INTEGER NOT NULL DEFAULT 1 CHECK(explanation_enabled IN (0, 1)),
        api_key TEXT,
        updated_by TEXT,
        updated_at TEXT,
        last_test_status TEXT,
        last_test_at TEXT,
        encryption_key_version TEXT
      )`,

      `CREATE TABLE agent_test_cases (
        id TEXT PRIMARY KEY,
        input_text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('completed', 'failed')),
        result_json TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX agent_test_cases_created
        ON agent_test_cases(created_at DESC)`
    ]
  },
  {
    // 媒体交付链（issue-151）：cover_url/media_url 改为公开媒体路由
    // /v1/media/<med_id>（发布时由仓储 UPDATE 写入），旧库已落对象键
    // 裸键（stored_path）的存量在此一次性改写；cover_media_id/media_id
    // 为 NULL 的行不触碰（自由文本/外链 URL 保持原值）。
    version: "0002_content_media_public_urls",
    statements: [
      `UPDATE content_items SET cover_url = '/v1/media/' || cover_media_id
       WHERE cover_media_id IS NOT NULL`,
      `UPDATE content_items SET media_url = '/v1/media/' || media_id
       WHERE media_id IS NOT NULL`
    ]
  },
  {
    // consent 扩 5 类 + patient_consents 单列 id（issue-155）：PG 直接
    // DROP/ADD CONSTRAINT 放宽 CHECK；id 回填为确定性派生值（主键唯一 ⇒
    // id 唯一），供 agent_conversations.save_consent_id 引用真实授权记录。
    version: "0003_consent_expansion",
    statements: [
      `ALTER TABLE patient_consents
       DROP CONSTRAINT patient_consents_consent_type_check`,
      `ALTER TABLE patient_consents
       ADD CONSTRAINT patient_consents_consent_type_check
       CHECK(consent_type IN ('privacy', 'medical_boundary', 'health_data',
                              'agent_session_save', 'location'))`,
      `ALTER TABLE patient_consents ADD COLUMN id TEXT`,
      `UPDATE patient_consents
       SET id = patient_id || ':' || consent_type || ':' || sequence::text`,
      `ALTER TABLE patient_consents ALTER COLUMN id SET NOT NULL`,
      `CREATE UNIQUE INDEX patient_consents_id ON patient_consents(id)`
    ]
  },
  {
    // 智能体设计 v4（与 SQLite 0011/0012 对齐，评审 P2-4/codex P0-3）：
    // agent_decisions.stage CHECK 加 screening/phase + phase_code/audience/
    // rule_package_status 列（全可空回滚兼容）；agent_plans 加
    // phase_code/audience 列（期别×人群双方案查询）。
    version: "0004_agent_v4_stages",
    statements: [
      `ALTER TABLE agent_decisions
       DROP CONSTRAINT agent_decisions_stage_check`,
      `ALTER TABLE agent_decisions
       ADD CONSTRAINT agent_decisions_stage_check
       CHECK(stage IN ('safety', 'screening', 'phase', 'applicability',
                       'severity', 'syndrome', 'plan_safety', 'completed'))`,
      `ALTER TABLE agent_decisions ADD COLUMN phase_code TEXT`,
      `ALTER TABLE agent_decisions ADD COLUMN audience TEXT`,
      `ALTER TABLE agent_decisions ADD COLUMN rule_package_status TEXT`,
      `ALTER TABLE agent_plans ADD COLUMN phase_code TEXT`,
      `ALTER TABLE agent_plans ADD COLUMN audience TEXT`
    ]
  },
  {
    // 小程序站内消息已读回执，与 SQLite 0016 语义一致。
    version: "0005_patient_message_reads",
    statements: [
      `CREATE TABLE patient_message_reads (
        message_id TEXT NOT NULL REFERENCES content_messages(id) ON DELETE CASCADE,
        patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        read_at TEXT NOT NULL,
        PRIMARY KEY(message_id, patient_id)
      )`,
      `CREATE INDEX patient_message_reads_patient
        ON patient_message_reads(patient_id, read_at DESC)`
    ]
  },
  {
    version: "0006_patient_external_identities",
    statements: [
      `CREATE TABLE patient_external_identities (
        provider TEXT NOT NULL CHECK(provider IN ('wechat_mini_program')),
        subject_hash TEXT NOT NULL,
        patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(provider, subject_hash),
        UNIQUE(provider, patient_id)
      )`
    ]
  },
  {
    version: "0007_knowledge_category",
    statements: ["ALTER TABLE agent_knowledge_items ADD COLUMN category TEXT"]
  },
  {
    version: "0008_patient_assessment_context",
    statements: [
      `CREATE TABLE agent_assessments (
        id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL REFERENCES patients(id),
        source_session_id TEXT NOT NULL REFERENCES agent_conversations(id),
        decision_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('current', 'superseded')),
        answers_snapshot_encrypted TEXT NOT NULL,
        answers_snapshot_hash TEXT NOT NULL,
        severity_code TEXT,
        syndrome_code TEXT NOT NULL,
        phase_code TEXT NOT NULL CHECK(phase_code IN ('acute', 'remission')),
        audience TEXT NOT NULL CHECK(audience IN ('child', 'adult')),
        plan_refs_json TEXT NOT NULL,
        rule_package_version TEXT NOT NULL,
        rule_package_hash TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        superseded_at TEXT
      )`,
      `CREATE INDEX agent_assessments_patient_current
        ON agent_assessments(patient_id, status, completed_at DESC)`,
      `CREATE UNIQUE INDEX agent_assessments_one_current_per_patient
        ON agent_assessments(patient_id) WHERE status = 'current'`,
      `ALTER TABLE agent_conversations ADD COLUMN assessment_id TEXT`
    ]
  },
  {
    version: "0009_knowledge_semantic_embeddings",
    statements: [
      `CREATE TABLE agent_knowledge_embeddings (
        knowledge_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
        model_name TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK(dimensions > 0),
        embedding BYTEA NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(knowledge_id, chunk_index),
        FOREIGN KEY(knowledge_id, chunk_index)
          REFERENCES agent_knowledge_chunks(knowledge_id, chunk_index)
          ON DELETE CASCADE
      )`,
      `CREATE INDEX agent_knowledge_embeddings_model
        ON agent_knowledge_embeddings(model_name, dimensions)`
    ]
  },
  {
    // 与 SQLite 0021 对齐：旧 category 迁为一级目录；目录不改变知识
    // 状态、正文、分块或向量。
    version: "0010_knowledge_folders",
    statements: [
      `CREATE TABLE agent_knowledge_folders (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES agent_knowledge_folders(id) ON DELETE RESTRICT,
        name TEXT NOT NULL CHECK(length(btrim(name)) > 0),
        sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0),
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX agent_knowledge_folders_root_name
        ON agent_knowledge_folders(name) WHERE parent_id IS NULL`,
      `CREATE UNIQUE INDEX agent_knowledge_folders_sibling_name
        ON agent_knowledge_folders(parent_id, name) WHERE parent_id IS NOT NULL`,
      `ALTER TABLE agent_knowledge_items
        ADD COLUMN folder_id TEXT REFERENCES agent_knowledge_folders(id) ON DELETE RESTRICT`,
      `INSERT INTO agent_knowledge_folders(
        id, parent_id, name, sort_order, created_by, created_at, updated_at
      )
      SELECT 'kfd_legacy_' || substr(md5(category), 1, 12), NULL, category,
             row_number() OVER (ORDER BY category) - 1, NULL,
             MIN(created_at), MAX(updated_at)
      FROM agent_knowledge_items
      WHERE category IS NOT NULL AND btrim(category) <> ''
      GROUP BY category`,
      `UPDATE agent_knowledge_items AS items
       SET folder_id = folders.id
       FROM agent_knowledge_folders AS folders
       WHERE items.folder_id IS NULL
         AND folders.parent_id IS NULL
         AND folders.name = items.category`,
      `CREATE INDEX agent_knowledge_items_folder
        ON agent_knowledge_items(folder_id, updated_at DESC)`
    ]
  },
  {
    version: "0011_content_category_registry",
    statements: [
      `CREATE TABLE content_category_registry (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('article', 'video')),
        parent_id TEXT REFERENCES content_category_registry(id) ON DELETE RESTRICT,
        name TEXT NOT NULL CHECK(length(btrim(name)) > 0),
        audience TEXT NOT NULL CHECK(audience IN ('adult', 'child', 'all')),
        node_type TEXT NOT NULL CHECK(node_type IN ('audience', 'group', 'leaf')),
        selectable INTEGER NOT NULL CHECK(selectable IN (0, 1)),
        display_order INTEGER NOT NULL DEFAULT 0 CHECK(display_order >= 0),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK((node_type = 'leaf' AND selectable = 1) OR selectable = 0)
      )`,
      `CREATE UNIQUE INDEX content_category_registry_root_name
        ON content_category_registry(kind, name) WHERE parent_id IS NULL`,
      `CREATE UNIQUE INDEX content_category_registry_sibling_name
        ON content_category_registry(kind, parent_id, name) WHERE parent_id IS NOT NULL`,
      `CREATE INDEX content_category_registry_tree
        ON content_category_registry(kind, parent_id, display_order, id)`,
      `CREATE TABLE content_item_category_links (
        content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
        category_id TEXT NOT NULL REFERENCES content_category_registry(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(content_id, category_id)
      )`,
      `CREATE INDEX content_item_category_links_category
        ON content_item_category_links(category_id, content_id)`,
      `CREATE TABLE content_category_migration_report (
        content_id TEXT PRIMARY KEY REFERENCES content_items(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('article', 'video')),
        title TEXT NOT NULL,
        legacy_category TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('migrated', 'unresolved')),
        reason TEXT NOT NULL,
        category_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `INSERT INTO content_category_registry(
        id, kind, parent_id, name, audience, node_type, selectable,
        display_order, status, revision, created_at, updated_at
      ) VALUES ${categorySeedValues}`,
      `INSERT INTO content_item_category_links(content_id, category_id, created_at)
       SELECT items.id, assignments.category_id, '2026-08-26T00:00:00.000Z'
       FROM content_items AS items
       JOIN (VALUES ${videoAssignmentValues}) AS assignments(title, category_id)
         ON items.kind = 'video' AND btrim(items.title) = assignments.title
       UNION ALL
       SELECT items.id, 'article-general', '2026-08-26T00:00:00.000Z'
       FROM content_items AS items
       WHERE items.kind = 'article'`,
      `INSERT INTO content_category_migration_report(
        content_id, kind, title, legacy_category, status, reason,
        category_ids_json, created_at
      )
       SELECT items.id, items.kind, items.title, items.category,
              CASE WHEN COUNT(links.category_id) > 0 THEN 'migrated' ELSE 'unresolved' END,
              CASE WHEN COUNT(links.category_id) > 0 AND items.kind = 'video' THEN 'video_truth_exact_title'
                   WHEN COUNT(links.category_id) > 0 THEN 'article_single_confirmed_category'
                   WHEN items.kind = 'article' THEN 'article_registry_missing'
                   ELSE 'video_title_not_in_truth' END,
              COALESCE(json_agg(links.category_id ORDER BY links.category_id)
                FILTER (WHERE links.category_id IS NOT NULL), '[]'::json)::text,
              '2026-08-26T00:00:00.000Z'
       FROM content_items AS items
       LEFT JOIN content_item_category_links AS links ON links.content_id = items.id
       WHERE items.kind IN ('article', 'video')
       GROUP BY items.id, items.kind, items.title, items.category`,
      `UPDATE content_items
       SET status = 'unpublished', patient_visible = 0,
           published_at = NULL, updated_at = '2026-08-26T00:00:00.000Z'
       WHERE id IN (
         SELECT content_id FROM content_category_migration_report
         WHERE status = 'unresolved'
       ) AND status = 'published'`
    ]
  }
];
