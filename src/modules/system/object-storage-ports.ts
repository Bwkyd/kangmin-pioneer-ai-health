/**
 * 对象存储端口：媒体素材与知识源文件的统一存储抽象。
 *
 * 两种后端：
 * - 本地文件系统（local/integration）：服务端直写，语义与现状等价；
 * - S3 兼容对象存储（staging/production）：预签名直传，服务端不接收
 *   客户端本地路径，上传分"申请票据 → 直传 → 校验和确认"三步。
 *
 * stored_path / 对象 key 约定：`<med_id>/<原始文件名>`，两种后端一致；
 * 本地实现存到 mediaDirectory 下，S3 实现存到 bucket 内。
 */

/** 预签名上传票据：CLI 以 HTTP PUT 直传到 url，携带指定头。 */
export interface ObjectUploadTicket {
  objectKey: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

export interface ObjectHead {
  sizeBytes: number;
}

export interface ObjectStoragePort {
  /** 服务端直写（本地模式与知识解析等内部路径使用）。 */
  putObject(input: {
    key: string;
    body: Buffer;
    contentType?: string | undefined;
  }): Promise<void>;

  /** 读取对象内容（知识解析、内容检测等服务端场景）。 */
  getObject(key: string): Promise<Buffer>;

  /** 对象元信息；不存在返回 null。 */
  headObject(key: string): Promise<ObjectHead | null>;

  /** 删除对象；不存在视为成功（清理语义幂等）。 */
  deleteObject(key: string): Promise<void>;

  /**
   * 申请预签名直传票据（远程模式第一步）。
   * 本地文件系统返回同源一次性票据；S3 返回预签名 URL。
   */
  createUploadTicket(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    /** 客户端计算的十六进制 SHA-256；票据把校验义务绑定进签名头。 */
    sha256: string;
  }): Promise<ObjectUploadTicket>;

  /**
   * 可选的同源直传接收器。本地文件系统实现用一次性票据接收浏览器 PUT；
   * S3 实现没有该方法，浏览器直接请求预签名 URL。
   */
  acceptUploadTicket?(input: {
    token: string;
    body: Buffer;
  }): Promise<void>;

  /**
   * 完成确认前的完整性校验：对象存在、大小一致、SHA-256（hex）一致。
   * 不一致返回 false（调用方据此标记失败并清理），不抛错。
   */
  verifyObject(input: {
    key: string;
    sha256: string;
    sizeBytes: number;
  }): Promise<boolean>;
}
