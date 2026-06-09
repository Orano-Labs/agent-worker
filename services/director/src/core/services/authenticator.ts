import { createPublicKey, verify } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { Container } from "@/helpers/container";
import { Result } from "@/helpers/result";
import { CommandLine } from "@/internal/command-line";
import { Database } from "@/internal/database";
import { Logger } from "@/internal/logger";
import { Variables } from "@/internal/variables";

export class Authenticator {
  #logger: Logger;
  #cli: CommandLine;
  #variables: Variables;
  #db: Database;

  constructor() {
    this.#logger = Container.inject(Logger).scope("Authenticator");
    this.#cli = Container.inject(CommandLine);
    this.#variables = Container.inject(Variables);
    this.#db = Container.inject(Database);
  }

  /**
   * 客户端 WebSocket 连接认证示例
   *
   * 认证流程说明：
   * 1. 准备 Supervisor UUID 和私钥（用于生成签名）
   * 2. 生成时间戳和随机数（防止重放攻击）
   * 3. 构造签名字符串：`uuid\ntimestamp\nnonce`
   * 4. 使用私钥对签名字符串进行数字签名
   * 5. 将认证信息通过 WebSocket 握手请求头发送给服务端
   *
   * 服务端验证逻辑：
   * - 验证时间戳是否在有效窗口内（±60秒）
   * - 根据 UUID 查询数据库获取公钥
   * - 使用公钥验证签名是否匹配
   * - 验证通过后建立 WebSocket 连接
   *
   * @example
   * ```typescript
   * import { cryptoSign } from "node:crypto";
   * import { WebSocket } from "ws";
   *
   * // Supervisor 身份信息
   * const uuid = "xxxxxxx-xxx-xx...";           // Supervisor 唯一标识
   * const privateKey = "-----BEGIN PRIVATE KEY .....";  // 私钥（PEM 格式）
   *
   * // 生成认证所需的动态参数
   * const timestamp = Date.now().toString();     // 当前时间戳（毫秒）
   * const nonce = crypto.randomUUID();           // 随机数，防止重放攻击
   *
   * // 构造待签名的载荷字符串
   * const payload = `${uuid}\n${timestamp}\n${nonce}`;
   *
   * console.log("Generating signature...");
   * console.log("  UID:", testData.uid);
   * console.log("  Timestamp:", timestamp);
   * console.log("  Nonce:", nonce);
   * console.log("  Payload:", payload.replace(/\n/g, "\\n"));
   *
   * // 使用私钥生成数字签名
   * const signature = cryptoSign(undefined, Buffer.from(payload), privateKey);
   *
   * console.log("  Signature:", signature.toString("hex").substring(0, 64) + "...\n");
   *
   * // 建立 WebSocket 连接，携带认证头信息
   * const ws = new WebSocket(`ws://xxxx`, {
   *   headers: {
   *     "x-supervisor-id": testData.uid,         // Supervisor UUID
   *     "x-timestamp": timestamp,                // 时间戳
   *     "x-nonce": nonce,                        // 随机数
   *     "x-signature": signature.toString("hex"), // 十六进制格式的签名
   *   },
   * });
   * ```
   */
  async authenticateSupervisorConnect(request: IncomingMessage): Promise<Result<Authenticator.SupervisorCredentials, { message: string }>> {
    const headers = {
      id: request.headers["x-supervisor-id"],
      timestamp: request.headers["x-timestamp"],
      nonce: request.headers["x-nonce"],
      signature: request.headers["x-signature"],
    };

    const parsed = z
      .object({
        id: z.uuid(),
        timestamp: z.string().regex(/^\d+$/),
        nonce: z.string().nonempty(),
        signature: z.string().nonempty(),
      })
      .safeParse(headers);

    if (!parsed.success) {
      return Result.error({ message: "Invalid headers" });
    }

    const timestamp = Number(parsed.data.timestamp);

    if (!Number.isInteger(timestamp) || timestamp < Date.now() - 1000 * 60 || timestamp > Date.now() + 1000 * 60) {
      return Result.error({ message: "Invalid timestamp" });
    }

    const [row] = await this.#db.client
      .select()
      .from(this.#db.schema.SUPERVISORS_TABLE)
      .where(eq(this.#db.schema.SUPERVISORS_TABLE.uid, this.#db.uuidToBuffer(parsed.data.id)))
      .limit(1);

    if (!row) {
      return Result.error({ message: "Supervisor not found" });
    }

    if (row.status === "inactive") {
      return Result.error({ message: "xx" });
    }

    const publicKey = createPublicKey({
      key: Buffer.from(row.publicKey, "hex"),
      type: "spki",
      format: "der",
    });

    const payload = `${parsed.data.id}\n${parsed.data.timestamp}\n${parsed.data.nonce}`;

    try {
      if (verify(undefined, Buffer.from(payload), publicKey, Buffer.from(parsed.data.signature, "hex"))) {
        return Result.ok({ id: parsed.data.id });
      } else {
        return Result.error({ message: "Invalid signature" });
      }
    } catch {
      return Result.error({ message: "Invalid signature" });
    }
  }
}

export namespace Authenticator {
  export type SupervisorCredentials = {
    id: string;
  };
}
