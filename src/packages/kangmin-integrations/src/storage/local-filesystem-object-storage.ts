/**
 * 本地文件系统对象存储（local/integration）。
 * 以 mediaDirectory 为根，key 为相对路径（`<med_id>/<文件名>`），
 * 语义与对象存储端口一致；浏览器上传通过 HTTP 层消费的一次性同源
 * 票据进入本地目录，不接受客户端提交服务器文件路径。
 */
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";

import { DomainError } from "@kangmin/core/kernel/errors";
import type {
  ObjectHead,
  ObjectStoragePort,
  ObjectUploadTicket
} from "@kangmin/core/operations/system/object-storage-ports";

export class LocalFilesystemObjectStorage implements ObjectStoragePort {
  private readonly root: string;
  private readonly uploadTickets = new Map<string, {
    key: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    expiresAt: number;
  }>();

  constructor(rootDirectory: string) {
    this.root = resolve(rootDirectory);
    mkdirSync(this.root, { recursive: true });
  }

  /** key 必须是根目录内的相对路径，禁止越界（../、绝对路径）。 */
  private resolveKey(key: string): string {
    const normalized = normalize(key);
    if (
      normalized.startsWith("..") ||
      normalized.includes(`..${sep}`) ||
      resolve(this.root, normalized) !== join(this.root, normalized)
    ) {
      throw new DomainError("validation_failed", "非法的对象键");
    }
    return join(this.root, normalized);
  }

  async putObject(input: {
    key: string;
    body: Buffer;
    contentType?: string | undefined;
  }): Promise<void> {
    const target = this.resolveKey(input.key);
    mkdirSync(dirname(target), { recursive: true });
    // 原子落盘：先写临时文件再改名，失败不留半成品。
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(temporary, input.body);
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw new DomainError("storage_unavailable", "素材存储不可用", {
        retryable: true,
        cause: error
      });
    }
  }

  async getObject(key: string): Promise<Buffer> {
    try {
      return readFileSync(this.resolveKey(key));
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DomainError("resource_not_found", "对象不存在");
      }
      throw new DomainError("storage_unavailable", "素材存储不可用", {
        retryable: true,
        cause: error
      });
    }
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const stat = statSync(this.resolveKey(key));
      return stat.isFile() ? { sizeBytes: stat.size } : null;
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new DomainError("storage_unavailable", "素材存储不可用", {
        retryable: true,
        cause: error
      });
    }
  }

  async deleteObject(key: string): Promise<void> {
    const target = this.resolveKey(key);
    rmSync(target, { force: true });
    // 对象按 `<id>/<文件名>` 组织：删除后清掉空 id 目录（不强制，忽略残留）。
    try {
      rmdirSync(dirname(target));
    } catch {
      // 目录非空或已不存在：无需处理。
    }
  }

  async createUploadTicket(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  }): Promise<ObjectUploadTicket> {
    const now = Date.now();
    for (const [token, ticket] of this.uploadTickets) {
      if (ticket.expiresAt <= now) this.uploadTickets.delete(token);
    }
    const token = randomBytes(32).toString("hex");
    const expiresAt = now + 15 * 60_000;
    this.uploadTickets.set(token, { ...input, expiresAt });
    return {
      objectKey: input.key,
      url: "/v1/admin/upload",
      method: "PUT",
      headers: {
        "content-type": input.contentType,
        "x-kangmin-upload-ticket": token
      },
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  async acceptUploadTicket(input: { token: string; body: Buffer }): Promise<void> {
    const ticket = this.uploadTickets.get(input.token);
    this.uploadTickets.delete(input.token);
    if (ticket === undefined || ticket.expiresAt <= Date.now()) {
      throw new DomainError("authentication_required", "上传票据无效或已过期");
    }
    const sha256 = createHash("sha256").update(input.body).digest("hex");
    if (input.body.length !== ticket.sizeBytes || sha256 !== ticket.sha256) {
      throw new DomainError("validation_failed", "上传内容与申请票据不一致");
    }
    await this.putObject({
      key: ticket.key,
      body: input.body,
      contentType: ticket.contentType
    });
  }

  async verifyObject(input: {
    key: string;
    sha256: string;
    sizeBytes: number;
  }): Promise<boolean> {
    let body: Buffer;
    try {
      body = readFileSync(this.resolveKey(input.key));
    } catch (error) {
      // 非法 key 是调用方错误，照常抛出；读取失败按校验不通过处理。
      if (error instanceof DomainError) {
        throw error;
      }
      return false;
    }
    if (body.length !== input.sizeBytes) {
      return false;
    }
    const digest = createHash("sha256").update(body).digest("hex");
    return digest === input.sha256.toLowerCase();
  }
}
