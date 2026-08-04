/**
 * S3 兼容对象存储（staging/production）。
 * 语义与 ObjectStoragePort 对齐；预签名直传分"申请票据 → 直传 →
 * 校验和确认"三步，内容校验（SHA-256）绑定进签名头，客户端直传时
 * 必须携带。endpoint 存在时强制 path-style（MinIO 等自建端点兼容）。
 */
import { createHash } from "node:crypto";

import {
  CreateBucketCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  PutObjectCommand,
  S3Client,
  type S3ServiceException
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { DomainError } from "../kernel/errors.js";
import type {
  ObjectHead,
  ObjectStoragePort,
  ObjectUploadTicket
} from "../modules/system/object-storage-ports.js";

/** 预签名直传票据有效期：15 分钟。 */
const UPLOAD_TICKET_TTL_SECONDS = 15 * 60;

export interface S3ObjectStorageOptions {
  bucket: string;
  endpoint?: string | undefined;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** hex SHA-256 转 base64（S3 ChecksumSHA256 要求的编码）。 */
function sha256HexToBase64(sha256Hex: string): string {
  return Buffer.from(sha256Hex, "hex").toString("base64");
}

function errorName(error: unknown): string | undefined {
  return (error as S3ServiceException | undefined)?.name;
}

export class S3ObjectStorage implements ObjectStoragePort {
  private readonly client: S3Client;
  private readonly bucket: string;
  /** bucket 懒创建：首次写入确认存在，之后不再重复检查。 */
  private bucketEnsured = false;

  constructor(options: S3ObjectStorageOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint !== undefined
        ? { endpoint: options.endpoint }
        : {}),
      // 自建端点（MinIO 等）默认不支持 virtual-host 风格寻址。
      forcePathStyle: options.endpoint !== undefined,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
      }
    });
  }

  /** 网络/服务错误统一映射 retryable storage_unavailable；DomainError 透传。 */
  private mapError(error: unknown): DomainError {
    if (error instanceof DomainError) {
      return error;
    }
    return new DomainError("storage_unavailable", "素材存储不可用", {
      retryable: true,
      cause: error
    });
  }

  /**
   * 执行 S3 操作；bucket 不存在时懒创建后重试一次
   * （测试与运维环境免预建桶）。其余错误原样上抛，由调用方映射。
   */
  private async withBucketRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation();
      this.bucketEnsured = true;
      return result;
    } catch (error) {
      if (this.bucketEnsured || errorName(error) !== "NoSuchBucket") {
        throw error;
      }
      // 并发创建时另一请求可能已建好：仅 BucketAlreadyOwnedByYou 可忽略。
      await this.client
        .send(new CreateBucketCommand({ Bucket: this.bucket }))
        .catch((createError: unknown) => {
          if (errorName(createError) !== "BucketAlreadyOwnedByYou") {
            throw createError;
          }
        });
      this.bucketEnsured = true;
      return operation();
    }
  }

  /**
   * 预签名前的建桶保证：签名本身是离线计算，不会触发
   * withBucketRetry 的懒创建路径，需要显式建桶。
   */
  private async ensureBucketForSigning(): Promise<void> {
    if (this.bucketEnsured) {
      return;
    }
    await this.client
      .send(new CreateBucketCommand({ Bucket: this.bucket }))
      .catch((error: unknown) => {
        // 与 withBucketRetry 同款：并发/既有桶仅 BucketAlreadyOwnedByYou 可忽略。
        if (errorName(error) !== "BucketAlreadyOwnedByYou") {
          throw error;
        }
      });
    this.bucketEnsured = true;
  }

  async putObject(input: {
    key: string;
    body: Buffer;
    contentType?: string | undefined;
  }): Promise<void> {
    try {
      await this.withBucketRetry(() =>
        this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: input.key,
            Body: input.body,
            ContentType: input.contentType
          })
        )
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async getObject(key: string): Promise<Buffer> {
    try {
      const response = await this.withBucketRetry(() =>
        this.client.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: key })
        )
      );
      if (response.Body === undefined) {
        throw new DomainError("resource_not_found", "对象不存在");
      }
      const bytes = await response.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (error) {
      if (errorName(error) === "NoSuchKey") {
        throw new DomainError("resource_not_found", "对象不存在", {
          cause: error
        });
      }
      throw this.mapError(error);
    }
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const response = await this.withBucketRetry(() =>
        this.client.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: key })
        )
      );
      return { sizeBytes: response.ContentLength ?? 0 };
    } catch (error) {
      // HeadObject 对缺失对象返回 404（name 为 NotFound / NoSuchKey）。
      const name = errorName(error);
      if (name === "NotFound" || name === "NoSuchKey") {
        return null;
      }
      throw this.mapError(error);
    }
  }

  async deleteObject(key: string): Promise<void> {
    // S3 DeleteObject 对不存在 key 同样返回成功：天然幂等。
    try {
      await this.withBucketRetry(() =>
        this.client.send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
        )
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async createUploadTicket(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  }): Promise<ObjectUploadTicket> {
    const checksumBase64 = sha256HexToBase64(input.sha256);
    // ChecksumSHA256 绑定进签名：客户端直传必须携带该校验头，
    // 服务端据此拒绝内容与票据不符的上传。
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ChecksumSHA256: checksumBase64
    });
    try {
      // getSignedUrl 是离线计算、不经 withBucketRetry：必须先确保
      // bucket 存在，否则客户端直传会拿到 404 NoSuchBucket
      //（issue-155：CI 全新 MinIO 上远程上传 e2e 确定性失败）。
      await this.ensureBucketForSigning();
      const url = await getSignedUrl(this.client, command, {
        expiresIn: UPLOAD_TICKET_TTL_SECONDS
      });
      return {
        objectKey: input.key,
        url,
        method: "PUT",
        headers: {
          "content-type": input.contentType,
          "x-amz-checksum-sha256": checksumBase64
        },
        expiresAt: new Date(
          Date.now() + UPLOAD_TICKET_TTL_SECONDS * 1000
        ).toISOString()
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async verifyObject(input: {
    key: string;
    sha256: string;
    sizeBytes: number;
  }): Promise<boolean> {
    let head: HeadObjectCommandOutput;
    try {
      head = await this.withBucketRetry(() =>
        this.client.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: input.key })
        )
      );
    } catch (error) {
      const name = errorName(error);
      if (name === "NotFound" || name === "NoSuchKey") {
        return false;
      }
      throw this.mapError(error);
    }

    if ((head.ContentLength ?? -1) !== input.sizeBytes) {
      return false;
    }

    const expectedChecksum = sha256HexToBase64(input.sha256.toLowerCase());
    if (head.ChecksumSHA256 !== undefined) {
      return head.ChecksumSHA256 === expectedChecksum;
    }

    // 对象无校验和（如外部工具直传绕过签名头）：GET 下载重算兜底。
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: input.key })
      );
      if (response.Body === undefined) {
        return false;
      }
      const bytes = await response.Body.transformToByteArray();
      const digest = createHash("sha256").update(bytes).digest("base64");
      return digest === expectedChecksum;
    } catch (error) {
      const name = errorName(error);
      if (name === "NotFound" || name === "NoSuchKey") {
        return false;
      }
      throw this.mapError(error);
    }
  }
}
