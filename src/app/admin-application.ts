import { randomUUID } from "node:crypto";

import { DomainError } from "../kernel/errors.js";
import { failure, success, type CommandResult } from "../kernel/result.js";
import {
  optionalIntegerInRange,
  optionalString,
  optionalStringArray,
  positiveInteger,
  requiredString,
  requiredStringArray
} from "../kernel/validation.js";
import type { AuditPort } from "../modules/system/audit-ports.js";
import { AdminAuthService } from "../modules/admin/admin-auth-service.js";
import type { AdminAccountRepository } from "../modules/admin/admin-account-repository.js";
import type { ContentAuxRepository } from "../modules/admin/content-aux-repository.js";
import { ContentAuxService } from "../modules/admin/content-aux-service.js";
import type { ContentAdminRepository } from "../modules/admin/content-admin-repository.js";
import { ContentAdminService } from "../modules/admin/content-admin-service.js";
import { AdminSessionService, type AdminIdentity } from "../modules/admin/admin-session-service.js";
import type { AdminSessionRepository } from "../modules/admin/admin-session-repository.js";
import { AgentAdminService } from "../modules/agent-admin/agent-admin-service.js";
import type { AgentAdminRepository, SyndromeRegistryPort } from "../modules/agent-admin/agent-admin-ports.js";
import { UserAdminService } from "../modules/user-admin/user-admin-service.js";
import type { UserReadRepository } from "../modules/user-admin/user-admin-ports.js";

export interface AdminCommandRequest {
  command: string;
  input?: Record<string, unknown> | undefined;
  adminToken?: string | undefined;
  requestId?: string | undefined;
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "failed" | "not_configured";
  message: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  healthy: boolean;
}

export type DoctorCheckProvider = () => Promise<DoctorReport>;

/** 高影响操作必须显式确认（发布/下架/删除/停用/启停），非交互不等待输入。 */
function requireConfirmation(input: Record<string, unknown>): void {
  if (input.yes !== true) {
    throw new DomainError(
      "confirmation_required",
      "高影响操作需要显式确认（--yes）"
    );
  }
}

function requireOwner(identity: AdminIdentity): void {
  if (identity.role !== "owner") {
    throw new DomainError(
      "permission_denied",
      "仅主管理员可以执行此操作"
    );
  }
}

function opt(input: Record<string, unknown>, key: string): string | undefined {
  return optionalString(input, key) ?? undefined;
}

function idempotencyKeyOf(input: Record<string, unknown>): string {
  const value = input.idempotencyKey;
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  // 每次 CLI 调用生成一次性幂等键：显式键仍获得重放保护。
  return randomUUID();
}

export class KangminAdminApplication {
  readonly sessions: AdminSessionService;
  private readonly auth: AdminAuthService;
  private readonly content: ContentAdminService;
  private readonly aux: ContentAuxService;
  private readonly agent: AgentAdminService;
  private readonly users: UserAdminService;

  constructor(
    sessionRepository: AdminSessionRepository,
    accountRepository: AdminAccountRepository,
    contentRepository: ContentAdminRepository,
    auxRepository: ContentAuxRepository,
    agentRepository: AgentAdminRepository,
    syndromeRegistry: SyndromeRegistryPort,
    userRepository: UserReadRepository,
    mediaDirectory: string,
    audit: AuditPort,
    private readonly closeResources: () => void = () => {},
    private readonly doctorProvider: DoctorCheckProvider = async () => ({
      checks: [],
      healthy: true
    })
  ) {
    this.sessions = new AdminSessionService(sessionRepository);
    this.auth = new AdminAuthService(accountRepository, sessionRepository, audit);
    this.content = new ContentAdminService(contentRepository, auxRepository, audit);
    this.aux = new ContentAuxService(auxRepository, mediaDirectory, audit);
    this.agent = new AgentAdminService(
      agentRepository,
      syndromeRegistry,
      mediaDirectory,
      audit
    );
    this.users = new UserAdminService(userRepository, audit);
  }

  async execute(request: AdminCommandRequest): Promise<CommandResult> {
    const command = request.command.trim();
    const input = request.input ?? {};

    try {
      if (command === "auth login") {
        return success(
          command,
          await this.auth.login(
            requiredString(input, "username"),
            typeof input.password === "string" ? input.password : ""
          ),
          request.requestId
        );
      }
      if (command === "auth status" || command === "auth whoami") {
        return success(
          command,
          await this.auth.status(request.adminToken),
          request.requestId
        );
      }
      if (command === "auth admins add") {
        const identity = await this.tryResolveAdmin(request.adminToken);
        return success(
          command,
          await this.auth.addAdmin(identity, {
            username: requiredString(input, "username"),
            password: typeof input.password === "string" ? input.password : "",
            role: requiredString(input, "role")
          }),
          request.requestId
        );
      }
      if (command === "doctor") {
        return success(
          command,
          await this.doctorProvider(),
          request.requestId
        );
      }

      // 除 auth login / admins add（合法携带 --role）外，客户端禁止提交身份。
      for (const key of ["adminId", "admin_id", "role"]) {
        if (Object.hasOwn(input, key)) {
          throw new DomainError(
            "permission_denied",
            "管理员身份和角色不能由客户端提交",
            { details: { field: key } }
          );
        }
      }

      const identity = await this.sessions.resolveIdentity(request.adminToken);
      const adminId = identity.adminId;

      switch (command) {
        // ---- auth ----
        case "auth logout":
          return success(
            command,
            await this.auth.logout(request.adminToken),
            request.requestId
          );
        case "auth admins list":
          return success(command, { items: await this.auth.listAdmins() }, request.requestId);
        case "auth admins enable":
          requireOwner(identity);
          return success(
            command,
            await this.auth.enableAdmin(requiredString(input, "id"), adminId),
            request.requestId
          );
        case "auth admins disable":
          requireOwner(identity);
          requireConfirmation(input);
          return success(
            command,
            await this.auth.disableAdmin(requiredString(input, "id"), adminId),
            request.requestId
          );

        // ---- content article ----
        case "content article create":
          return success(
            command,
            await this.content.create(adminId, {
              title: requiredString(input, "title"),
              category: opt(input, "category") ?? "",
              summary: opt(input, "summary") ?? "",
              body: opt(input, "body") ?? "",
              source: opt(input, "source") ?? "",
              coverMediaId: opt(input, "coverMediaId") ?? null,
              mediaId: opt(input, "mediaId") ?? null,
              instructions: opt(input, "instructions") ?? "",
              precautions: opt(input, "precautions") ?? "",
              disclaimer: opt(input, "disclaimer") ?? "",
              methodTags: optionalStringArray(input, "methodTags") ?? [],
              displayOrder: optionalIntegerInRange(input, "displayOrder", 0, 1_000_000) ?? 0,
              idempotencyKey: idempotencyKeyOf(input)
            }),
            request.requestId
          );
        case "content article list":
          return success(
            command,
            { items: await this.content.list(this.statusOf(opt(input, "status"))) },
            request.requestId
          );
        case "content article show":
          return success(
            command,
            await this.content.get(requiredString(input, "id")),
            request.requestId
          );
        case "content article preview":
          return success(
            command,
            await this.content.preview(requiredString(input, "id")),
            request.requestId
          );
        case "content article update":
          return success(
            command,
            await this.content.update(
              requiredString(input, "id"),
              positiveInteger(input, "expectedRevision"),
              this.contentChanges(input)
            ),
            request.requestId
          );
        case "content article publish":
        case "content article unpublish":
          requireConfirmation(input);
          return success(
            command,
            command.endsWith("unpublish")
              ? await this.content.unpublish(
                  adminId,
                  requiredString(input, "id"),
                  positiveInteger(input, "expectedRevision")
                )
              : await this.content.publish(
                  adminId,
                  requiredString(input, "id"),
                  positiveInteger(input, "expectedRevision")
                ),
            request.requestId
          );

        // ---- content video ----
        case "content video create":
          return success(
            command,
            await this.content.createVideo(adminId, {
              title: requiredString(input, "title"),
              category: opt(input, "category") ?? "",
              summary: opt(input, "summary") ?? "",
              body: opt(input, "body") ?? "",
              source: opt(input, "source") ?? "",
              coverMediaId: opt(input, "coverMediaId") ?? null,
              mediaId: opt(input, "mediaId") ?? null,
              instructions: opt(input, "instructions") ?? "",
              precautions: opt(input, "precautions") ?? "",
              disclaimer: opt(input, "disclaimer") ?? "",
              methodTags: optionalStringArray(input, "methodTags") ?? [],
              displayOrder: optionalIntegerInRange(input, "displayOrder", 0, 1_000_000) ?? 0,
              idempotencyKey: idempotencyKeyOf(input)
            }),
            request.requestId
          );
        case "content video list":
          return success(
            command,
            { items: await this.content.listVideos(this.statusOf(opt(input, "status"))) },
            request.requestId
          );
        case "content video show":
          return success(
            command,
            await this.content.getVideo(requiredString(input, "id")),
            request.requestId
          );
        case "content video preview":
          return success(
            command,
            await this.content.previewVideo(requiredString(input, "id")),
            request.requestId
          );
        case "content video update":
          return success(
            command,
            await this.content.updateVideo(
              requiredString(input, "id"),
              positiveInteger(input, "expectedRevision"),
              this.contentChanges(input)
            ),
            request.requestId
          );
        case "content video publish":
        case "content video unpublish":
          requireConfirmation(input);
          return success(
            command,
            command.endsWith("unpublish")
              ? await this.content.unpublishVideo(
                  adminId,
                  requiredString(input, "id"),
                  positiveInteger(input, "expectedRevision")
                )
              : await this.content.publishVideo(
                  adminId,
                  requiredString(input, "id"),
                  positiveInteger(input, "expectedRevision")
                ),
            request.requestId
          );

        // ---- content media ----
        case "content media upload":
          return success(
            command,
            await this.aux.uploadMedia(
              adminId,
              requiredString(input, "file"),
              opt(input, "kind")
            ),
            request.requestId
          );
        case "content media list":
          return success(command, { items: await this.aux.listMedia() }, request.requestId);
        case "content media show":
          return success(
            command,
            await this.aux.getMedia(requiredString(input, "id")),
            request.requestId
          );
        case "content media disable":
          requireConfirmation(input);
          return success(
            command,
            await this.aux.disableMedia(requiredString(input, "id")),
            request.requestId
          );
        case "content media delete":
          requireConfirmation(input);
          return success(
            command,
            await this.aux.deleteMedia(requiredString(input, "id")),
            request.requestId
          );

        // ---- content category ----
        case "content category create":
          return success(
            command,
            await this.aux.createCategory(adminId, {
              name: requiredString(input, "name"),
              kind: requiredString(input, "kind"),
              description: opt(input, "description"),
              displayOrder: optionalIntegerInRange(input, "displayOrder", 0, 1_000_000)
            }),
            request.requestId
          );
        case "content category list":
          return success(
            command,
            { items: await this.aux.listCategories(opt(input, "kind")) },
            request.requestId
          );
        case "content category show":
          return success(
            command,
            await this.aux.getCategory(requiredString(input, "id")),
            request.requestId
          );
        case "content category update":
          return success(
            command,
            await this.aux.updateCategory(
              requiredString(input, "id"),
              positiveInteger(input, "expectedRevision"),
              {
                name: opt(input, "name"),
                kind: opt(input, "kind"),
                description: opt(input, "description"),
                displayOrder: optionalIntegerInRange(input, "displayOrder", 0, 1_000_000)
              }
            ),
            request.requestId
          );
        case "content category disable":
          requireConfirmation(input);
          return success(
            command,
            await this.aux.disableCategory(
              requiredString(input, "id"),
              positiveInteger(input, "expectedRevision")
            ),
            request.requestId
          );

        // ---- content message ----
        case "content message create":
          return success(
            command,
            await this.aux.createMessage(adminId, {
              title: requiredString(input, "title"),
              body: requiredString(input, "body"),
              summary: opt(input, "summary"),
              categoryId: opt(input, "categoryId")
            }),
            request.requestId
          );
        case "content message list":
          return success(
            command,
            { items: await this.aux.listMessages(opt(input, "status")) },
            request.requestId
          );
        case "content message show":
          return success(
            command,
            await this.aux.getMessage(requiredString(input, "id")),
            request.requestId
          );
        case "content message update":
          return success(
            command,
            await this.aux.updateMessage(
              requiredString(input, "id"),
              positiveInteger(input, "expectedRevision"),
              {
                title: opt(input, "title"),
                body: opt(input, "body"),
                summary: opt(input, "summary"),
                categoryId: opt(input, "categoryId")
              }
            ),
            request.requestId
          );
        case "content message publish":
        case "content message unpublish":
          requireConfirmation(input);
          return success(
            command,
            command.endsWith("unpublish")
              ? await this.aux.unpublishMessage(
                  adminId,
                  requiredString(input, "id"),
                  positiveInteger(input, "expectedRevision")
                )
              : await this.aux.publishMessage(
                  adminId,
                  requiredString(input, "id"),
                  positiveInteger(input, "expectedRevision")
                ),
            request.requestId
          );

        // ---- agent status ----
        case "agent status":
          return success(command, await this.agent.status(), request.requestId);

        // ---- agent knowledge ----
        case "agent knowledge list":
          return success(
            command,
            { items: await this.agent.listKnowledge(opt(input, "status")) },
            request.requestId
          );
        case "agent knowledge show":
          return success(
            command,
            await this.agent.getKnowledge(requiredString(input, "id")),
            request.requestId
          );
        case "agent knowledge add":
          return success(
            command,
            await this.agent.addKnowledge(adminId, requiredString(input, "file"), {
              source: opt(input, "source"),
              description: opt(input, "description")
            }),
            request.requestId
          );
        case "agent knowledge index":
          return success(
            command,
            await this.agent.indexKnowledge(requiredString(input, "id")),
            request.requestId
          );
        case "agent knowledge enable":
          requireConfirmation(input);
          return success(
            command,
            await this.agent.enableKnowledge(
              adminId,
              requiredString(input, "id")
            ),
            request.requestId
          );
        case "agent knowledge disable":
          requireConfirmation(input);
          return success(
            command,
            await this.agent.disableKnowledge(
              adminId,
              requiredString(input, "id")
            ),
            request.requestId
          );
        case "agent knowledge search-test":
          return success(
            command,
            { items: await this.agent.searchKnowledge(requiredString(input, "query")) },
            request.requestId
          );

        // ---- agent plan ----
        case "agent plan create":
          return success(
            command,
            await this.agent.createPlan(adminId, {
              name: requiredString(input, "name"),
              syndrome: requiredString(input, "syndrome"),
              method: opt(input, "method"),
              steps: optionalStringArray(input, "steps"),
              precautions: opt(input, "precautions"),
              risks: opt(input, "risks"),
              contraindications: opt(input, "contraindications"),
              applicableAge: opt(input, "applicableAge"),
              videoResourceId: opt(input, "videoResourceId"),
              displayOrder: optionalIntegerInRange(input, "displayOrder", 0, 1_000_000)
            }),
            request.requestId
          );
        case "agent plan list":
          return success(
            command,
            { items: await this.agent.listPlans(opt(input, "status")) },
            request.requestId
          );
        case "agent plan show":
          return success(
            command,
            await this.agent.getPlan(requiredString(input, "id")),
            request.requestId
          );
        case "agent plan preview":
          return success(
            command,
            await this.agent.previewPlan(requiredString(input, "id")),
            request.requestId
          );
        case "agent plan update":
          return success(
            command,
            await this.agent.updatePlan(
              requiredString(input, "id"),
              positiveInteger(input, "expectedRevision"),
              this.planChanges(input)
            ),
            request.requestId
          );
        case "agent plan enable":
          requireConfirmation(input);
          return success(
            command,
            await this.agent.enablePlan(
              adminId,
              requiredString(input, "id"),
              positiveInteger(input, "expectedRevision")
            ),
            request.requestId
          );
        case "agent plan disable":
          requireConfirmation(input);
          return success(
            command,
            await this.agent.disablePlan(
              adminId,
              requiredString(input, "id"),
              positiveInteger(input, "expectedRevision")
            ),
            request.requestId
          );
        case "agent plan mappings":
          return success(command, { items: await this.agent.mappings() }, request.requestId);

        // ---- agent model ----
        case "agent model show":
          return success(
            command,
            await this.agent.showModelConfig(),
            request.requestId
          );
        case "agent model update":
          return success(
            command,
            await this.agent.updateModelConfig(adminId, {
              provider: opt(input, "provider"),
              modelName: opt(input, "modelName"),
              timeoutSeconds: optionalIntegerInRange(input, "timeout", 1, 300),
              maxOutputTokens: optionalIntegerInRange(input, "maxOutput", 128, 32768),
              knowledgeRetrievalEnabled: this.optionalBoolean(input, "knowledgeRetrieval"),
              retrievalCount: optionalIntegerInRange(input, "retrievalCount", 1, 20),
              explanationEnabled: this.optionalBoolean(input, "explanationEnabled"),
              apiKey: opt(input, "apiKey")
            }),
            request.requestId
          );
        case "agent model test":
          return success(
            command,
            await this.agent.testModel(adminId),
            request.requestId
          );

        // ---- agent test ----
        case "agent test run":
          return success(command, await this.agent.runTest(), request.requestId);
        case "agent test case":
          return success(
            command,
            await this.agent.getTestCase(requiredString(input, "id")),
            request.requestId
          );

        // ---- users ----
        case "users list":
          return success(
            command,
            await this.users.list({
              limit: optionalIntegerInRange(input, "limit", 1, 100),
              activeWithin: opt(input, "activeWithin"),
              query: opt(input, "query")
            }),
            request.requestId
          );
        case "users show":
          return success(
            command,
            await this.users.get(requiredString(input, "id")),
            request.requestId
          );
        case "users activity":
          return success(command, await this.users.activity(), request.requestId);
        case "users sessions":
          requireOwner(identity);
          return success(
            command,
            await this.users.sessions(adminId, requiredString(input, "id")),
            request.requestId
          );
        case "users records":
          requireOwner(identity);
          return success(
            command,
            await this.users.records(adminId, requiredString(input, "id"), opt(input, "type")),
            request.requestId
          );

        default:
          throw new DomainError(
            "command_invalid",
            `未知命令：${command || "(empty)"}`
          );
      }
    } catch (error) {
      return failure(command, error, request.requestId);
    }
  }

  close(): void {
    this.closeResources();
  }

  /** 引导路径：无有效令牌返回 null（首个 owner 创建不需要登录）。 */
  private async tryResolveAdmin(
    token: string | undefined
  ): Promise<AdminIdentity | null> {
    if (token === undefined || token.trim() === "") {
      return null;
    }
    try {
      return await this.sessions.resolveIdentity(token);
    } catch {
      return null;
    }
  }

  private statusOf(value: string | undefined): "draft" | "published" | "unpublished" | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value !== "draft" && value !== "published" && value !== "unpublished") {
      throw new DomainError(
        "validation_failed",
        "status 必须是 draft、published 或 unpublished"
      );
    }
    return value;
  }

  private optionalBoolean(
    input: Record<string, unknown>,
    key: string
  ): boolean | undefined {
    const value = input[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "boolean") {
      throw new DomainError(
        "validation_failed",
        `${key} 必须是 true 或 false`
      );
    }
    return value;
  }

  private contentChanges(input: Record<string, unknown>) {
    return {
      title: opt(input, "title"),
      category: opt(input, "category"),
      summary: opt(input, "summary"),
      body: opt(input, "body"),
      source: opt(input, "source"),
      coverMediaId: opt(input, "coverMediaId"),
      mediaId: opt(input, "mediaId"),
      instructions: opt(input, "instructions"),
      precautions: opt(input, "precautions"),
      disclaimer: opt(input, "disclaimer"),
      methodTags: optionalStringArray(input, "methodTags"),
      displayOrder: optionalIntegerInRange(input, "displayOrder", 0, 1_000_000)
    };
  }

  private planChanges(input: Record<string, unknown>) {
    return {
      name: opt(input, "name"),
      syndrome: opt(input, "syndrome"),
      method: opt(input, "method"),
      steps: optionalStringArray(input, "steps"),
      precautions: opt(input, "precautions"),
      risks: opt(input, "risks"),
      contraindications: opt(input, "contraindications"),
      applicableAge: opt(input, "applicableAge"),
      videoResourceId: opt(input, "videoResourceId"),
      displayOrder: optionalIntegerInRange(input, "displayOrder", 0, 1_000_000)
    };
  }
}
