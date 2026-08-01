/**
 * 本地文件系统对象存储（local/integration）。
 * 以 mediaDirectory 为根，key 为相对路径（`<med_id>/<文件名>`），
 * 语义与对象存储端口一致；不支持预签名直传（远程上传必须配对
 * S3 兼容后端）。
 */
import { createHash } from "node:crypto";
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

import { DomainError } from "../kernel/errors.js";
import type {
  ObjectHead,
  ObjectStoragePort,
  ObjectUploadTicket
} from "../modules/system/object-storage-ports.js";

export class LocalFilesystemObjectStorage implements ObjectStoragePort {
  private readonly root: string;

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

  async createUploadTicket(): Promise<ObjectUploadTicket> {
    throw new DomainError(
      "capability_unavailable",
      "本地文件系统存储不支持预签名直传；远程上传需配置 S3 兼容对象存储"
    );
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
