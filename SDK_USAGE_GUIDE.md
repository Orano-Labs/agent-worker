# Director SDK 使用指南

本文档对应 `services/director/src/sdk` 当前实现，以及它导出的 `api.v1` Protobuf 定义。SDK 包名为 `@aw/vm-director`，包含两个独立入口：

| 入口 | 导出 | 用途 |
| --- | --- | --- |
| `@aw/vm-director/sdk` | `Client`、所有 `*PB` 命名空间 | 带请求签名的 Director Connect RPC 客户端 |
| `@aw/vm-director/tunnel` | `TunnelClient` | 将 Director 的项目隧道反向转发到本地 HTTP/HTTPS 服务 |

> 本 SDK 是 TypeScript SDK。RPC 采用 Connect 协议，Director 服务端默认挂载在 `${baseUrl}/grpc`；因此示例中的 `baseUrl` 必须包含 `/grpc`。

## 1. 安装与运行环境

在使用方项目中安装 SDK 及 Node.js Connect transport：

```bash
pnpm add @aw/vm-director @connectrpc/connect-node
```

`Client` 依赖 Web Crypto 的 Ed25519 实现。Node.js 请使用支持 `globalThis.crypto.subtle` 与 Ed25519 的现代版本（推荐 Node.js 20+）。私钥绝不能进入浏览器或提交到代码仓库；推荐将 SDK 运行在后端、CLI 或 Supervisor 进程中。

## 2. 最小可用客户端

`Client` 接收一个 Connect `Transport` 和身份信息。它会为每个 unary 或流式 RPC 自动添加签名请求头，调用方不需要自行构造 `x-request-signature`。

```ts
import { Client, ProjectPB } from "@aw/vm-director/sdk";
import { createConnectTransport } from "@connectrpc/connect-node";

const transport = createConnectTransport({
  // Director 的 Connect 路由前缀是 /grpc。
  baseUrl: "https://director.example.com/grpc",
  httpVersion: "2",
});

const client = new Client(transport, {
  type: "user",
  id: process.env.DIRECTOR_USER_ID!,
  // 32 字节 Ed25519 seed 的十六进制字符串，不是 PEM，也不是 Base64。
  privateKey: process.env.DIRECTOR_USER_PRIVATE_KEY_HEX!,
});

const projects = client.createProjectService();
const response = await projects.list(
  Client.createMessageValid(ProjectPB.ProjectServiceListRequestSchema, {
    page: 1,
    pageSize: 20,
  }),
);

console.log(response.projects, response.total);
```

### 2.1 身份与服务权限

身份决定签名中携带的主体，也决定服务端允许调用的服务。身份与能力的对应关系如下：

| `Client.Identity` | 可调用服务 | 典型用途 |
| --- | --- | --- |
| `{ type: "manager", privateKey }` | `UserService`、`SupervisorService` | 管理员创建/管理用户和 Supervisor |
| `{ type: "user", id, privateKey }` | `ProjectService`、`TemplateService` | 上层应用代表某个用户管理项目与模板 |
| `{ type: "supervisor", id, privateKey }` | `SupervisorPortalService` | Supervisor 保活、接收分配、确认和释放实例 |

错误的身份调用其它服务会收到 `PermissionDenied`。生产环境下，用户/Supervisor 的 `id` 必须是已登记且未删除的 24 字符 ID；manager 公钥由 Director 的 `AW_DIRECTOR_MANAGER_PUBLIC_KEY` 配置决定。

```ts
const managerClient = new Client(transport, {
  type: "manager",
  privateKey: process.env.DIRECTOR_MANAGER_PRIVATE_KEY_HEX!,
});

const supervisorClient = new Client(transport, {
  type: "supervisor",
  id: process.env.DIRECTOR_SUPERVISOR_ID!,
  privateKey: process.env.DIRECTOR_SUPERVISOR_PRIVATE_KEY_HEX!,
});
```

### 2.2 生产签名与开发签名

默认第三个构造参数为 `false`，即生产签名模式。每次 RPC 都会生成新的 32 字节 nonce 和当前秒级时间戳，签名内容为：

```text
manager:    hex(nonce):unixSeconds
user:       hex(nonce):unixSeconds:userId
supervisor: hex(nonce):unixSeconds:supervisorId
```

SDK 用身份私钥对上述字符串作 Ed25519 签名，再把序列化后的 Protobuf 放入 `x-request-signature`。服务端会验证签名、5 分钟时间窗口及 nonce 防重放，故不要缓存或复用请求头。

本地非生产 Director 可使用开发模式：

```ts
const localClient = new Client(
  transport,
  { type: "user", id: "24-character-user-id-here", privateKey: "not-used-by-dev-server" },
  true,
);
```

该模式发送 `x-request-signature-development`，服务端只读取身份、不校验私钥。**只能用于非生产环境**；生产 Director 不接受这个头。

### 2.3 请求消息、二进制元数据与调用选项

RPC 的请求类型是 Buf Protobuf message。最稳妥的创建方式是 `Client.createMessageValid(schema, value)`；它负责补全 SDK 类型所需的 Protobuf message 标识。

```ts
const encodeMetadata = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decodeMetadata = (value?: Uint8Array) =>
  value ? JSON.parse(new TextDecoder().decode(value)) : undefined;

const timeout = AbortSignal.timeout(10_000);

const result = await projects.create(
  Client.createMessageValid(ProjectPB.ProjectServiceCreateRequestSchema, {
    name: "my-app",
    metadata: encodeMetadata({ displayName: "我的应用", region: "cn" }),
    resourceTier: ProjectPB.ProjectResourceTier.STANDARD,
  }),
  { signal: timeout },
);

console.log(decodeMetadata(result.project.metadata));
```

`metadata` 是最多 2048 字节的任意 `Uint8Array`，并非 SDK 自动 JSON 字段；上例仅是一种 JSON 编码约定。可选 wrapper 字段在 TypeScript 中以 `undefined` 表示未设置，例如 `templateId?: string`、`disabled?: boolean`。所有列表调用使用从 1 开始的 `page` 和 `pageSize`，且 `pageSize` 范围为 `1..100`。

传给每个方法的第二个参数是 Connect `CallOptions`，可用于 `signal`（取消或超时）、`headers`、`timeoutMs` 等。SDK 会保留调用方的 header，并覆盖/写入自己的签名 header。

```ts
await projects.get(
  Client.createMessageValid(ProjectPB.ProjectServiceGetRequestSchema, { id: projectId }),
  { timeoutMs: 5_000, headers: { "x-trace-id": crypto.randomUUID() } },
);
```

## 3. RPC API 完整参考

以下所有示例均假定已按第 2 节创建了对应身份的 `Client`，并使用 `Client.createMessageValid()` 创建请求。请求字段采用 TypeScript camelCase；例如 proto 的 `page_size` 对应 `pageSize`。

### 3.1 管理员：用户管理（`UserService`）

取得服务：

```ts
import { Client, UserPB } from "@aw/vm-director/sdk";

const users = managerClient.createUserService();
```

| 方法 | 请求 | 返回/作用 |
| --- | --- | --- |
| `create` | `disabled?`, `metadata?` | 创建用户并**仅在此时**返回 `user` 与 `privateKey` |
| `get` | `id` | 返回用户详情 |
| `list` | `page`, `pageSize`, `disabled?` | 返回 `{ users, total }` |
| `updateMetadata` | `id`, `metadata?` | 更新元数据并返回用户 |
| `enable` / `disable` | `id` | 切换用户登录状态并返回用户 |
| `delete` | `id` | 软删除用户 |

```ts
// 创建后立刻持久化 ID 和私钥；私钥不会在后续 get/list 中再次出现。
const created = await users.create(
  Client.createMessageValid(UserPB.UserServiceCreateRequestSchema, {
    disabled: false,
    metadata: encodeMetadata({ email: "dev@example.com", name: "Dev" }),
  }),
);
const userId = created.user.id;
const privateKeyHex = Buffer.from(created.privateKey).toString("hex");

await users.updateMetadata(
  Client.createMessageValid(UserPB.UserServiceUpdateMetadataRequestSchema, {
    id: userId,
    metadata: encodeMetadata({ email: "dev@example.com", plan: "pro" }),
  }),
);

await users.disable(Client.createMessageValid(UserPB.UserServiceDisableRequestSchema, { id: userId }));
await users.enable(Client.createMessageValid(UserPB.UserServiceEnableRequestSchema, { id: userId }));

const page = await users.list(
  Client.createMessageValid(UserPB.UserServiceListRequestSchema, {
    page: 1,
    pageSize: 50,
    disabled: false,
  }),
);

const detail = await users.get(Client.createMessageValid(UserPB.UserServiceGetRequestSchema, { id: userId }));
await users.delete(Client.createMessageValid(UserPB.UserServiceDeleteRequestSchema, { id: userId }));
```

`User` 含 `id`、`publicKey`、`metadata?`、`disabled`、`createTime` 和 `updateTime`。用户 ID 是 24 字符；`privateKey` 与 `publicKey` 都是字节数组，创建用户得到的 `privateKey` 要转换为 hex 后作为 user SDK 的 `privateKey`。

### 3.2 管理员：Supervisor 管理（`SupervisorService`）

取得服务：

```ts
import { Client, SupervisorPB } from "@aw/vm-director/sdk";

const supervisors = managerClient.createSupervisorService();
```

| 方法 | 请求 | 返回/作用 |
| --- | --- | --- |
| `create` | `metadata?` | 注册 Supervisor，返回 `supervisor` 与只返回一次的 `privateKey` |
| `get` | `id` | 返回详情（含实时 `online`） |
| `list` | `page`, `pageSize`, `disabled?` | 返回 `{ supervisors, total }` |
| `updateMetadata` | `id`, `metadata?` | 更新元数据 |
| `delete` | `id` | 删除离线 Supervisor；在线时返回 `FailedPrecondition` |

```ts
const created = await supervisors.create(
  Client.createMessageValid(SupervisorPB.SupervisorServiceCreateRequestSchema, {
    metadata: encodeMetadata({ zone: "cn-shanghai-1", hostname: "sup-01" }),
  }),
);

const supervisorId = created.supervisor.id;
const supervisorPrivateKeyHex = Buffer.from(created.privateKey).toString("hex");

await supervisors.updateMetadata(
  Client.createMessageValid(SupervisorPB.SupervisorServiceUpdateMetadataRequestSchema, {
    id: supervisorId,
    metadata: encodeMetadata({ zone: "cn-shanghai-1", capacity: 8 }),
  }),
);

const { supervisors: items, total } = await supervisors.list(
  Client.createMessageValid(SupervisorPB.SupervisorServiceListRequestSchema, { page: 1, pageSize: 20 }),
);

const { supervisor } = await supervisors.get(
  Client.createMessageValid(SupervisorPB.SupervisorServiceGetRequestSchema, { id: supervisorId }),
);

// 仅在 supervisor.online 为 false 后执行。
await supervisors.delete(Client.createMessageValid(SupervisorPB.SupervisorServiceDeleteRequestSchema, { id: supervisorId }));
```

将 `supervisorId` 与 `supervisorPrivateKeyHex` 作为 Supervisor 进程的密钥配置。`online` 由服务端 lease 状态计算，并非可写字段。

### 3.3 用户：模板管理（`TemplateService`）

模板是可复制的文件系统目录。`create` 新建目录，`fork` 复制源模板目录；可用模板 ID 在创建项目时通过 `templateId` 初始化项目目录。

```ts
import { Client, TemplatePB } from "@aw/vm-director/sdk";

const templates = client.createTemplateService();
```

| 方法 | 请求 | 返回/作用 |
| --- | --- | --- |
| `create` | `metadata?` | 创建 draft 模板与其目录 |
| `get` | `id` | 返回模板详情 |
| `list` | `page`, `pageSize`, `status` | 返回 `{ templates, total }` |
| `updateMetadata` | `id`, `metadata?` | 更新元数据 |
| `updateStatus` | `id`, `status` | 设为 `DRAFT`、`PUBLISHED` 或 `ARCHIVED` |
| `fork` | `from`, `metadata?` | 复制源模板目录，返回新模板 |
| `delete` | `id` | 软删除模板 |

```ts
const first = await templates.create(
  Client.createMessageValid(TemplatePB.TemplateServiceCreateRequestSchema, {
    metadata: encodeMetadata({ name: "Node Starter", runtime: "node-22" }),
  }),
);
const templateId = first.template.id;

await templates.updateMetadata(
  Client.createMessageValid(TemplatePB.TemplateServiceUpdateMetadataRequestSchema, {
    id: templateId,
    metadata: encodeMetadata({ name: "Node Starter", description: "基础 Node 项目" }),
  }),
);
await templates.updateStatus(
  Client.createMessageValid(TemplatePB.TemplateServiceUpdateStatusRequestSchema, {
    id: templateId,
    status: TemplatePB.TemplateStatus.PUBLISHED,
  }),
);

const fork = await templates.fork(
  Client.createMessageValid(TemplatePB.TemplateServiceForkRequestSchema, {
    from: templateId,
    metadata: encodeMetadata({ name: "Node Starter + Prisma" }),
  }),
);

const listed = await templates.list(
  Client.createMessageValid(TemplatePB.TemplateServiceListRequestSchema, {
    page: 1,
    pageSize: 20,
    status: TemplatePB.TemplateStatus.PUBLISHED,
  }),
);
const current = await templates.get(
  Client.createMessageValid(TemplatePB.TemplateServiceGetRequestSchema, { id: fork.template.id }),
);
await templates.delete(Client.createMessageValid(TemplatePB.TemplateServiceDeleteRequestSchema, { id: fork.template.id }));
```

`Template` 的状态枚举为 `TemplatePB.TemplateStatus.DRAFT`、`PUBLISHED`、`ARCHIVED`（不要传 `UNSPECIFIED`）。`forkedFrom` 存在时表示源模板 ID。

### 3.4 用户：项目管理（`ProjectService`）

项目只对其 owner 可见和可修改。资源档位必须是非 `UNSPECIFIED` 值。

```ts
import { Client, ProjectPB } from "@aw/vm-director/sdk";

const projects = client.createProjectService();
```

| 方法 | 请求 | 返回/作用 |
| --- | --- | --- |
| `create` | `name`, `metadata?`, `resourceTier`, `templateId?` | 创建用户项目；传 `templateId` 时复制模板目录 |
| `get` | `id` | 返回项目详情 |
| `list` | `page`, `pageSize` | 返回当前用户的 `{ projects, total }` |
| `updateMetadata` | `id`, `metadata?` | 更新元数据 |
| `delete` | `id` | 删除项目；项目存在运行中的实例时返回 `FailedPrecondition` |

```ts
const created = await projects.create(
  Client.createMessageValid(ProjectPB.ProjectServiceCreateRequestSchema, {
    name: "sales-dashboard",
    metadata: encodeMetadata({ title: "销售看板", repo: "git@example.com:team/sales.git" }),
    resourceTier: ProjectPB.ProjectResourceTier.STANDARD,
    templateId, // 可选：省略则从空目录创建
  }),
);
const projectId = created.project.id;

await projects.updateMetadata(
  Client.createMessageValid(ProjectPB.ProjectServiceUpdateMetadataRequestSchema, {
    id: projectId,
    metadata: encodeMetadata({ title: "销售看板 v2" }),
  }),
);

const project = await projects.get(
  Client.createMessageValid(ProjectPB.ProjectServiceGetRequestSchema, { id: projectId }),
);
const page = await projects.list(
  Client.createMessageValid(ProjectPB.ProjectServiceListRequestSchema, { page: 1, pageSize: 20 }),
);

// 在项目实例停止后才可删除。
await projects.delete(Client.createMessageValid(ProjectPB.ProjectServiceDeleteRequestSchema, { id: projectId }));
```

资源档位：`ProjectPB.ProjectResourceTier.MINIMUM`、`STANDARD`、`PERFORMANCE`。`Project` 返回 `id`、`metadata?`、`createTime`、`updateTime`、`resourceTier` 和可选的 `templateId`。

### 3.5 Supervisor：实例分配门户（`SupervisorPortalService`）

Supervisor 以自己的身份调用此服务。`watch()` 是 SDK 中唯一的服务端流式 RPC，返回 `AsyncIterable`。同一 Supervisor 同时只能有一个活跃 watch；连接建立后先收到当前负载快照，之后收到更新或 keepalive。

```ts
import { Client, SupervisorPortalPB } from "@aw/vm-director/sdk";

const portal = supervisorClient.createSupervisorPortalService();
```

| 方法 | 请求 | 返回/作用 |
| --- | --- | --- |
| `watch` | 空消息 | 服务端流：`keepalive` 或 `load` 事件 |
| `acknowledge` | `instanceId`, `status` | 接受或拒绝一次实例分配 |
| `release` | `instanceId` | 通知服务端实例已释放 |
| `heartbeat` | 空消息 | 刷新 Supervisor lease，维持 online 状态 |

```ts
const streamAbort = new AbortController();

async function runWatch() {
  try {
    const events = portal.watch(
      Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceWatchRequestSchema, {}),
      { signal: streamAbort.signal },
    );

    for await (const event of events) {
      switch (event.event.case) {
        case "keepalive":
          // 无业务负载时约每 15 秒到达一次。
          break;
        case "load":
          for (const load of event.event.value.list) {
            try {
              // 根据 load.projectId、load.projectResourceTier 启动/保持实例。
              await startInstance(load.instanceId, load.projectId, load.projectResourceTier);

              await portal.acknowledge(
                Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceAcknowledgeRequestSchema, {
                  instanceId: load.instanceId,
                  status: SupervisorPortalPB.AcknowledgeStatus.OK,
                }),
              );
            } catch (error) {
              await portal.acknowledge(
                Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceAcknowledgeRequestSchema, {
                  instanceId: load.instanceId,
                  status: SupervisorPortalPB.AcknowledgeStatus.REJECT,
                }),
              );
              console.error("启动实例失败", load.instanceId, error);
            }
          }
          break;
      }
    }
  } catch (error) {
    if (!streamAbort.signal.aborted) throw error;
  }
}

const heartbeatTimer = setInterval(() => {
  void portal.heartbeat(
    Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceHeartbeatRequestSchema, {}),
  );
}, 10_000);

void runWatch();

// 当本地实例退出后：
await portal.release(
  Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceReleaseRequestSchema, {
    instanceId: "24-character-instance-id",
  }),
);

// 正常关闭：
clearInterval(heartbeatTimer);
streamAbort.abort();
```

`load` 事件的 `list` 是该 Supervisor 的**完整当前负载列表**，而不是仅增量变更；上层应用应据此做状态收敛。每个 `Load` 含 `instanceId`、`projectId`、`projectResourceTier`、`confirmed` 与 `timestamp`。`AcknowledgeStatus` 只能用 `OK` 或 `REJECT`，不能用 `UNSPECIFIED`。

## 4. 反向隧道（`TunnelClient`）

`TunnelClient` 为一个本地目标服务维护多条升级后的 TCP 连接。Director 从连接池取连接并将外部 HTTP/SSE/WebSocket 请求转发到本地目标；客户端会把每个 HTTP 请求的 `Host` 头重写为 `target.hostname`，支持 keep-alive 的连续请求和 WebSocket upgrade。

```ts
import { TunnelClient } from "@aw/vm-director/tunnel";

const controller = new AbortController();

const tunnel = new TunnelClient({
  // HTTP 隧道服务基地址；与 gRPC baseUrl 不同，不要附加 /grpc。
  baseUrl: "https://director.example.com",
  project: process.env.PROJECT_ID!,
  token: process.env.PROJECT_TUNNEL_TOKEN!,
  // 本地实际运行的应用。http 使用 TCP，https 使用 TLS。
  target: new URL("http://127.0.0.1:3000"),
  // 保持多个空闲连接，提高并发能力。
  maxSockets: 5,
  logger: {
    debug: (message, context) => console.debug(message, context),
    info: (message, context) => console.info(message, context),
    warn: (message, context) => console.warn(message, context),
    error: (message, context) => console.error(message, context),
  },
});

tunnel.start(controller.signal);

process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
```

`start(signal)` 是同步启动方法，不返回“已连接” Promise；连接建立在后台进行。它只能对同一个实例调用一次，否则抛出 `TunnelClient is already started`。当连接失败或断开时，每条 socket 会在约 1 秒后自动重连；调用 `controller.abort()` 会关闭连接池且停止重连。需要重启时，创建新的 `TunnelClient` 实例。

注意：当 `target` 使用 `https:` 时，当前实现会关闭目标 TLS 证书校验（`rejectUnauthorized: false`）。将 target 指向本机或受控网络服务；不要把它视为对任意公网 HTTPS 上游的证书安全校验。

## 5. 错误处理与工程建议

Connect RPC 错误通常以 `ConnectError` 抛出，可通过 `code` 判断：

```ts
import { Code, ConnectError } from "@connectrpc/connect";

try {
  await projects.get(Client.createMessageValid(ProjectPB.ProjectServiceGetRequestSchema, { id: projectId }));
} catch (error) {
  if (error instanceof ConnectError) {
    if (error.code === Code.Unauthenticated) {
      // 检查 ID、私钥 hex 格式、Director 时钟及签名环境。
    } else if (error.code === Code.PermissionDenied) {
      // 当前 identity 无权调用此服务。
    } else if (error.code === Code.NotFound) {
      // ID 不存在、已删除，或项目不属于当前用户。
    } else if (error.code === Code.FailedPrecondition) {
      // 例如删除运行中项目，或删除在线 Supervisor。
    }
  }
  throw error;
}
```

- 保存 `createUserService().create()` 和 `createSupervisorService().create()` 返回的私钥时，使用密钥管理服务或至少限制文件权限；服务端不会再次返回它们。
- 生产调用确保客户端和 Director 时钟同步。服务端只接受时间差不超过 5 分钟的签名。
- 以 `AbortController` 管理页面卸载、进程退出和流重连。对于 `watch()`，网络中断后应在应用层做退避重连。
- 不要把 `UNSPECIFIED` 用作资源档位、模板状态或确认状态；这些请求会被服务端的 proto 校验拒绝。
- 对可能重试的变更操作，先评估业务幂等性。SDK 自动重试的是 Tunnel 的连接，不会自动重试 RPC。

## 6. 当前版本边界与已知行为

本节用于避免上层应用依赖“声明了但尚未由 SDK/服务端提供”的能力。

1. `project.proto` 中虽然定义了 `ProjectServiceLaunchRequest/Response`，但 `ProjectService` 描述、SDK 创建的客户端和服务端路由均未暴露 `launch()`；当前不可调用。
2. `UserService.list` 的 `disabled`、`SupervisorService.list` 的 `disabled` 以及 `TemplateService.list` 的 `status` 字段已出现在请求类型中，但当前服务端实现尚未据此过滤结果。调用可正常成功，但上层应自行过滤，直到服务端补齐筛选逻辑。
3. 项目 `create` 请求中的 `name` 会参与协议校验，但当前服务端创建项目时不持久化或返回这个名称。需要展示名称时，请在 `metadata` 中保存自己的字段。
4. SDK 的公共 RPC 能力以五个 `Client#create*Service()` 返回的实际方法为准：User（7）、Supervisor（5）、Template（7）、Project（5）、Supervisor Portal（4）。没有额外的动态/隐式 RPC 方法。

