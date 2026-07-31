import { DomainError } from "../kernel/errors.js";
import { failure, success, type CommandResult } from "../kernel/result.js";
import { optionalString, positiveInteger, requiredString } from "../kernel/validation.js";
import { AdminSessionService } from "../modules/admin/admin-session-service.js";
import type { AdminSessionRepository } from "../modules/admin/admin-session-repository.js";
import { ContentAdminService } from "../modules/admin/content-admin-service.js";
import type { ContentAdminRepository } from "../modules/admin/content-admin-repository.js";

export class KangminAdminApplication {
  readonly sessions: AdminSessionService;
  private readonly content: ContentAdminService;
  constructor(sessionRepo: AdminSessionRepository, contentRepo: ContentAdminRepository, private readonly closeResources: () => void = () => {}) {
    this.sessions = new AdminSessionService(sessionRepo);
    this.content = new ContentAdminService(contentRepo);
  }
  async execute(request: { command: string; input?: Record<string, unknown>; adminToken?: string | undefined; requestId?: string }): Promise<CommandResult> {
    const command = request.command.trim(); const input = request.input ?? {};
    try {
      for (const key of ["adminId", "admin_id", "role"]) if (Object.hasOwn(input, key)) throw new DomainError("permission_denied", "管理员身份和角色不能由客户端提交");
      const adminId = await this.sessions.resolve(request.adminToken);
      switch (command) {
        case "content article create": return success(command, await this.content.create(adminId, {
          title: optionalString(input,"title") ?? "", category: optionalString(input,"category") ?? "",
          summary: optionalString(input,"summary") ?? "", body: optionalString(input,"body") ?? "",
          source: optionalString(input,"source") ?? "", idempotencyKey: requiredString(input,"idempotencyKey")
        }), request.requestId);
        case "content article list": return success(command, { items: await this.content.list() }, request.requestId);
        case "content article show": case "content article preview": return success(command, await this.content.get(requiredString(input,"id")), request.requestId);
        case "content article update": {
          const changes: Record<string,string> = {};
          for (const key of ["title","category","summary","body","source"] as const) { const value = optionalString(input,key); if (value !== undefined) changes[key] = value ?? ""; }
          return success(command, await this.content.update(requiredString(input,"id"), positiveInteger(input,"expectedRevision"), changes), request.requestId);
        }
        case "content article publish": case "content article unpublish": {
          if (input.yes !== true) throw new DomainError("confirmation_required", "发布或下架需要显式确认");
          const args = [requiredString(input,"id"), positiveInteger(input,"expectedRevision")] as const;
          return success(command, command.endsWith("unpublish") ? await this.content.unpublish(...args) : await this.content.publish(...args), request.requestId);
        }
        default: throw new DomainError("command_invalid", `未知命令：${command || "(empty)"}`);
      }
    } catch (error) { return failure(command, error, request.requestId); }
  }
  close() { this.closeResources(); }
}
