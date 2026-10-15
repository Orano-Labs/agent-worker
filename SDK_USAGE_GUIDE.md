# Director SDK 使用指南

本文档基于当前 `services/director/src/sdk`、Protobuf 协议和 Director 服务端路由编写，适用于使用 `@aw/vm-director` 开发管理后台、用户应用、Supervisor 或项目访问网关。

SDK 有两个入口：

| 导入路径 | 核心导出 | 用途 |
| --- | --- | --- |
| `@aw/vm-director/sdk` | `Client`、`FileSystemPB`、`ProjectPB`、`UserPB`、`SupervisorPB`、`SupervisorPortalPB`、`TemplatePB`、`SignaturePB` | 自动签名的 Connect RPC 客户端，以及全部 Protobuf schema 和枚举 |
| `@aw/vm-director/tunnel` | `TunnelClient` | Supervisor 反向隧道：接收 Director 转发的 HTTP、SSE、WebSocket 请求，并路由到本地目标服务 |

## 1. 安装与前提

```bash
pnpm add @aw/vm-director @connectrpc/connect-node
```

SDK 使用 Web Crypto 的 Ed25519 实现签名。建议在 Node.js 20+ 的后端、CLI 或 Supervisor 进程中使用，**不要将私钥下发到浏览器**。

Director 提供两类 HTTP 端点：

| 端点 | 用途 | 认证身份 |
| --- | --- | --- |
| `${DIRECTOR_URL}/grpc/...` | Connect RPC | 取决于 RPC 服务 |
| `${DIRECTOR_URL}/link/:projectId/:path*` | 访问运行中项目的 HTTP / SSE / WebSocket | user |
| `${DIRECTOR_URL}/tunnel`（HTTP Upgrade） | Supervisor 建立反向隧道 | supervisor |

创建 Connect transport 时，`baseUrl` 必须带 `/grpc`；建立隧道时，`TunnelClient.baseUrl` 则必须是 Director 的 HTTP 根地址，SDK 会自行请求 `${baseUrl}/tunnel`。

## 2. 认证与 `Client`

`Client` 接收 Connect `Transport` 与身份，自动为每一个 unary、客户端流、服务端流、双向流请求添加签名头。因此业务代码无需手工拼装 `x-request-signature`。

Director 的 Connect 适配器开启了 Connect 和 gRPC-Web，没有开启原生 gRPC。Node 客户端可用 `createConnectTransport` 或 `createGrpcWebTransport`；`createGrpcTransport` 会连不上。当前 Supervisor 使用 gRPC-Web 和 HTTP/1.1。

```ts
import { Client, ProjectPB } from "@aw/vm-director/sdk";
import { createConnectTransport } from "@connectrpc/connect-node";

const transport = createConnectTransport({
  baseUrl: "https://director.example.com/grpc",
  // 根据部署选择 http/1.1 或 http/2；Connect transport 的其它选项也可照常传入。
  httpVersion: "2",
});

const userClient = new Client(transport, {
  type: "user",
  id: process.env.DIRECTOR_USER_ID!,
  privateKey: process.env.DIRECTOR_USER_PRIVATE_KEY_HEX!,
});

const projects = userClient.createProjectService();
const page = await projects.list(
  Client.createMessageValid(ProjectPB.ProjectServiceListRequestSchema, {
    page: 1,
    pageSize: 20,
  }),
);
```

### 2.1 身份与权限

`Client.Identity` 有三种形式。服务端按服务名做访问控制；能创建 service client 不代表该身份有权限调用它。

| 身份 | 类型 | 可调用 RPC 服务 | 可调用 HTTP 端点 |
| --- | --- | --- | --- |
| 管理员 | `{ type: "manager", privateKey }` | `UserService`、平台级 `SupervisorService`、模板类型的 `FileSystemService`、尚未实现的 `FileUploadService` | 无 |
| 用户 | `{ type: "user", id, privateKey }` | 自己名下的 `SupervisorService`、`ProjectService`、`TemplateService`、自己项目的 `FileSystemService`、尚未实现的 `FileUploadService` | 仅自己拥有项目的 `/link/:projectId/...` |
| Supervisor | `{ type: "supervisor", id, privateKey }` | `SupervisorPortalService` | `/tunnel` Upgrade |

生产环境中，`id` 必须是服务端已登记、未删除的 24 字符 ID。RPC 权限不匹配会收到 `PermissionDenied`。`/link` 缺少有效签名返回 `401`，身份不是 user 返回 `403`，项目不存在或不属于该用户返回 `404`。`/tunnel` 在 Supervisor 还没有通过活跃的 `watch()` 流建立 lease 时返回 `503`。

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

### 2.2 私钥格式与签名机制

`privateKey` 是**DER 编码 PKCS#8 Ed25519 私钥的十六进制字符串**。创建 user 或 supervisor 后，服务端会把这个二进制私钥放在 `privateKey: Uint8Array` 中返回；应立即转成 hex 并安全保存：

```ts
const privateKeyHex = Buffer.from(created.privateKey).toString("hex");
```

生产模式（默认）中，每次请求都会生成新的 32 字节 nonce 和秒级时间戳，签名字符串为：

```text
manager:    hex(nonce):unixSeconds
user:       hex(nonce):unixSeconds:userId
supervisor: hex(nonce):unixSeconds:supervisorId
```

SDK 将签名、nonce、时间戳和身份编码为 `SignaturePB.Signature`，以 Base64 写入 `x-request-signature`。服务端会校验 Ed25519 签名、5 分钟时间窗口与 nonce 防重放，所以不要缓存或复用该 header。

本地非生产环境可启用开发模式：

```ts
const localClient = new Client(
  transport,
  {
    type: "user",
    id: "123456789012345678901234",
    privateKey: "development-mode-does-not-sign",
  },
  true,
);
```

开发模式使用 `x-request-signature-development`，服务端只读取编码后的身份而不验签。生产服务不会接受该 header。

### 2.3 创建 Protobuf 请求与调用选项

服务方法需要 Buf Protobuf message。用 `Client.createMessageValid(schema, value)` 创建可获得完整的类型推导，字段名使用 TypeScript camelCase：`page_size` 写为 `pageSize`。

```ts
const encodeMetadata = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decodeMetadata = (value?: Uint8Array) =>
  value === undefined ? undefined : JSON.parse(new TextDecoder().decode(value));

const created = await projects.create(
  Client.createMessageValid(ProjectPB.ProjectServiceCreateRequestSchema, {
    name: "my-app",
    metadata: encodeMetadata({ title: "我的应用", region: "cn" }),
    resourceTier: ProjectPB.ProjectResourceTier.STANDARD,
  }),
  { signal: AbortSignal.timeout(10_000) },
);
```

`metadata` 是最多 2048 字节的任意 `Uint8Array`，不是自动 JSON 字段；上面的 JSON 编码仅为推荐约定。Proto wrapper 可选字段用 `undefined` 表示未设置，例如 `templateId?: string`、`disabled?: boolean`。列表参数统一为从 1 开始的 `page`，`pageSize` 范围为 `1..100`。

每个方法的第二个参数是 Connect `CallOptions`，可传 `signal`、`timeoutMs`、`headers` 等：

```ts
await projects.get(
  Client.createMessageValid(ProjectPB.ProjectServiceGetRequestSchema, { id: projectId }),
  { timeoutMs: 5_000, headers: { "x-trace-id": crypto.randomUUID() } },
);
```

## 3. RPC 能力完整参考

### 3.1 管理员：用户管理（`UserService`）

```ts
import { Client, UserPB } from "@aw/vm-director/sdk";

const users = managerClient.createUserService();
```

| 方法 | 请求字段 | 返回/作用 |
| --- | --- | --- |
| `create` | `disabled?`, `metadata?` | 创建用户；返回 `user` 与仅返回一次的 `privateKey` |
| `get` | `id` | 查询用户 |
| `list` | `page`, `pageSize`, `disabled?` | 返回 `{ users, total }` |
| `updateMetadata` | `id`, `metadata?` | 更新元数据，返回用户 |
| `enable` / `disable` | `id` | 切换用户状态，返回用户 |
| `delete` | `id` | 软删除用户 |

```ts
const created = await users.create(
  Client.createMessageValid(UserPB.UserServiceCreateRequestSchema, {
    disabled: false,
    metadata: encodeMetadata({ email: "dev@example.com", name: "Dev" }),
  }),
);

const userId = created.user.id;
const userPrivateKeyHex = Buffer.from(created.privateKey).toString("hex");
// 立即把 userId 和 userPrivateKeyHex 放入密钥管理服务；之后 get/list 不会返回私钥。

await users.updateMetadata(
  Client.createMessageValid(UserPB.UserServiceUpdateMetadataRequestSchema, {
    id: userId,
    metadata: encodeMetadata({ email: "dev@example.com", plan: "pro" }),
  }),
);
await users.disable(Client.createMessageValid(UserPB.UserServiceDisableRequestSchema, { id: userId }));
await users.enable(Client.createMessageValid(UserPB.UserServiceEnableRequestSchema, { id: userId }));

const { users: items, total } = await users.list(
  Client.createMessageValid(UserPB.UserServiceListRequestSchema, { page: 1, pageSize: 50 }),
);
const { user } = await users.get(Client.createMessageValid(UserPB.UserServiceGetRequestSchema, { id: userId }));
await users.delete(Client.createMessageValid(UserPB.UserServiceDeleteRequestSchema, { id: userId }));
```

`User` 含 `id`、`publicKey`、`metadata?`、`disabled`、`createTime` 和 `updateTime`。

### 3.2 管理员与用户：Supervisor 管理（`SupervisorService`）

Supervisor 是承载项目实例和隧道连接的节点。创建时必须声明可分配容量 `capacity`（大于等于 1）；该容量会由 Director 的调度器消耗和释放。

manager 和 user 都能调用该服务，但数据范围不同：manager 创建和管理 `ownerId = null` 的平台 Supervisor；user 创建和管理归属于自己的 Supervisor。两类身份互相看不到、不能修改或删除对方范围内的节点。`Supervisor` 的公开消息目前不含 `ownerId`，归属由调用身份隐式决定。

```ts
import { Client, SupervisorPB } from "@aw/vm-director/sdk";

// 用户自建节点；管理平台节点时改用 managerClient。
const supervisors = userClient.createSupervisorService();
```

| 方法 | 请求字段 | 返回/作用 |
| --- | --- | --- |
| `create` | `capacity`, `metadata?` | 注册节点；返回 `supervisor` 与仅返回一次的 `privateKey` |
| `get` | `id` | 查询节点，含实时 `online` 和总 `capacity` |
| `list` | `page`, `pageSize`, `disabled?` | 返回 `{ supervisors, total }` |
| `updateMetadata` | `id`, `metadata?` | 更新元数据 |
| `delete` | `id` | 仅可删除离线节点；在线时为 `FailedPrecondition` |

```ts
const created = await supervisors.create(
  Client.createMessageValid(SupervisorPB.SupervisorServiceCreateRequestSchema, {
    capacity: 8,
    metadata: encodeMetadata({ zone: "cn-shanghai-1", hostname: "sup-01" }),
  }),
);

const supervisorId = created.supervisor.id;
const supervisorPrivateKeyHex = Buffer.from(created.privateKey).toString("hex");

await supervisors.updateMetadata(
  Client.createMessageValid(SupervisorPB.SupervisorServiceUpdateMetadataRequestSchema, {
    id: supervisorId,
    metadata: encodeMetadata({ zone: "cn-shanghai-1", labels: ["linux", "x64"] }),
  }),
);

const { supervisors: items } = await supervisors.list(
  Client.createMessageValid(SupervisorPB.SupervisorServiceListRequestSchema, { page: 1, pageSize: 20 }),
);
const { supervisor } = await supervisors.get(
  Client.createMessageValid(SupervisorPB.SupervisorServiceGetRequestSchema, { id: supervisorId }),
);

if (!supervisor.online) {
  await supervisors.delete(Client.createMessageValid(SupervisorPB.SupervisorServiceDeleteRequestSchema, { id: supervisorId }));
}
```

`Supervisor` 返回 `id`、`publicKey`、`metadata?`、`online`、`capacity`、创建和更新时间。它不返回剩余容量；剩余容量由调度器内部维护。

当前 `list.disabled` 尚未参与筛选；此外，`list().total` 当前统计所有未删除 Supervisor，而 `supervisors` 数组会按调用身份的 owner 范围过滤。对 user 或存在用户自建节点的 manager 来说，`total` 可能大于当前身份实际可分页访问的记录数。

### 3.3 用户：模板管理（`TemplateService`）

模板对应可复制的项目文件目录：`create` 创建新目录，`fork` 复制已有模板目录；创建项目时可通过 `templateId` 使用它初始化项目目录。

```ts
import { Client, TemplatePB } from "@aw/vm-director/sdk";

const templates = userClient.createTemplateService();
```

| 方法 | 请求字段 | 返回/作用 |
| --- | --- | --- |
| `create` | `metadata?` | 创建 draft 模板和目录 |
| `get` | `id` | 查询模板 |
| `list` | `page`, `pageSize`, `status` | 返回 `{ templates, total }` |
| `updateMetadata` | `id`, `metadata?` | 更新元数据 |
| `updateStatus` | `id`, `status` | 设置为草稿、已发布或已归档 |
| `fork` | `from`, `metadata?` | 复制源模板目录，返回新模板 |
| `delete` | `id` | 软删除模板 |

```ts
const first = await templates.create(
  Client.createMessageValid(TemplatePB.TemplateServiceCreateRequestSchema, {
    metadata: encodeMetadata({ name: "Node Starter", runtime: "node-22" }),
  }),
);
const templateId = first.template.id;

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
await templates.delete(Client.createMessageValid(TemplatePB.TemplateServiceDeleteRequestSchema, { id: fork.template.id }));
```

状态只能使用 `TemplatePB.TemplateStatus.DRAFT`、`PUBLISHED` 或 `ARCHIVED`，不能使用 `UNSPECIFIED`。`Template.forkedFrom` 存在时表示源模板 ID。

### 3.4 用户：项目管理（`ProjectService`）

项目仅对 owner 可见和可修改。资源档位会影响部署调度所需容量：`MINIMUM` 为 1、`STANDARD` 为 2、`PERFORMANCE` 为 4。

```ts
import { Client, ProjectPB } from "@aw/vm-director/sdk";

const projects = userClient.createProjectService();
```

| 方法 | 请求字段 | 返回/作用 |
| --- | --- | --- |
| `create` | `name`, `metadata?`, `resourceTier`, `templateId?`, `supervisorId?`, `workspace?` | 创建项目；指定模板时复制其目录。后两个字段当前仅存在于协议，服务实现尚未应用 |
| `get` | `id` | 查询项目 |
| `list` | `page`, `pageSize` | 返回当前用户 `{ projects, total }` |
| `updateMetadata` | `id`, `metadata?` | 更新项目元数据 |
| `delete` | `id` | 软删除项目；存在运行中实例时为 `FailedPrecondition` |

```ts
const created = await projects.create(
  Client.createMessageValid(ProjectPB.ProjectServiceCreateRequestSchema, {
    name: "sales-dashboard",
    metadata: encodeMetadata({ title: "销售看板", repo: "git@example.com:team/sales.git" }),
    resourceTier: ProjectPB.ProjectResourceTier.STANDARD,
    templateId,
  }),
);
const projectId = created.project.id;

await projects.updateMetadata(
  Client.createMessageValid(ProjectPB.ProjectServiceUpdateMetadataRequestSchema, {
    id: projectId,
    metadata: encodeMetadata({ title: "销售看板 v2" }),
  }),
);
const { project } = await projects.get(
  Client.createMessageValid(ProjectPB.ProjectServiceGetRequestSchema, { id: projectId }),
);
const page = await projects.list(
  Client.createMessageValid(ProjectPB.ProjectServiceListRequestSchema, { page: 1, pageSize: 20 }),
);

// 必须在项目实例已经释放后调用。
await projects.delete(Client.createMessageValid(ProjectPB.ProjectServiceDeleteRequestSchema, { id: projectId }));
```

资源档位使用 `ProjectPB.ProjectResourceTier.MINIMUM`、`STANDARD`、`PERFORMANCE`；不要传 `UNSPECIFIED`。

`Project` 消息和 `create` 请求已经声明 `supervisorId?`（固定承载节点）与 `workspace?`（宿主机工作目录，最长 1024 字符）。但当前 `ProjectService` 创建逻辑尚未持久化这两个请求字段，`create/get/list/updateMetadata` 也没有在响应中填充它们；调度器当前仍从所有在线且容量足够的 Supervisor 中选择节点。因此，上层应用暂时不要依赖这两个字段。`name` 同样只经过协议校验，当前不会持久化；需要展示名称时仍应写入 `metadata`。

### 3.5 文件系统（`FileSystemService`）

`FileSystemService` 读写项目或模板的持久化目录。身份和文件系统类型必须匹配：

| `FileSystemType` | 可用身份 | 访问范围 |
| --- | --- | --- |
| `PROJECT` | user | 仅当前用户拥有且未删除的项目 |
| `TEMPLATE` | manager | 任意未删除的模板 |

user 不能访问模板目录，manager 也不能访问项目目录。Supervisor 无权调用该服务。每个请求都通过 `FileSystem` 消息选择目录：

```ts
import { Client, FileSystemPB } from "@aw/vm-director/sdk";

const fileSystem = userClient.createFileSystemService();
const projectFs = Client.createMessageValid(FileSystemPB.FileSystemSchema, {
	type: FileSystemPB.FileSystemType.PROJECT,
	id: projectId,
});
```

当前服务端实现六个方法。`move` 和 `copy` 已出现在协议和客户端类型中，但服务端尚未实现。

| 方法 | 请求字段 | 返回或行为 |
| --- | --- | --- |
| `tree` | `fs`, `root?`, `depth` | 返回目录信息和子节点。`depth` 范围是 `0..10` |
| `read` | `fs`, `target` | 一次读取一个不超过 10 MiB 的文件 |
| `write` | `fs`, `target`, `content` | 覆盖已存在的普通文件。内容不超过 10 MiB |
| `create` | `fs`, `target`, `directory` | 创建空文件，或递归创建目录 |
| `delete` | `fs`, `path` | 递归删除文件或目录，但不能删除文件系统根目录 |
| `download` | `fs`, `path` | 以服务端流返回 ZIP 数据块。每块不超过 64 KiB。当前实现有归档结束缺陷，见下文 |

#### 查看目录树

```ts
const tree = await fileSystem.tree(
	Client.createMessageValid(FileSystemPB.FileSystemServiceTreeRequestSchema, {
		fs: projectFs,
		root: "/src",
		depth: 2,
	}),
);

function printNode(node: FileSystemPB.TreeNodeValid, prefix = "") {
	console.log(`${prefix}${node.name} (${node.size} bytes)`);

	switch (node.type.case) {
		case "file":
			console.log(`${prefix}  MIME: ${node.type.value.mimetype}`);
			break;
		case "directory":
			if (node.type.value.loaded) {
				for (const child of node.type.value.children) {
					printNode(child, `${prefix}  `);
				}
			}
			break;
		case "symlink":
			console.log(`${prefix}  -> ${node.type.value.target}`);
			break;
		case undefined:
			throw new Error(`Tree node ${node.name} has no type`);
	}
}

for (const node of tree.children) {
	printNode(node);
}
```

`depth: 0` 返回 `root` 的直接子节点，但不加载子目录内容。`TreeNodeDirectory.loaded` 表示 `children` 是否已加载。每个节点带 `mtime`、`ctime` 和 `bigint` 类型的 `size`。当前服务端将普通文件的 MIME 类型统一返回为 `application/octet-stream`。

#### 创建、读取、写入和删除

`write` 只覆盖已存在的文件。先用 `create` 创建文件；如果父目录不存在，也先创建目录。

```ts
await fileSystem.create(
	Client.createMessageValid(FileSystemPB.FileSystemServiceCreateRequestSchema, {
		fs: projectFs,
		target: "/config",
		directory: true,
	}),
);

await fileSystem.create(
	Client.createMessageValid(FileSystemPB.FileSystemServiceCreateRequestSchema, {
		fs: projectFs,
		target: "/config/app.json",
		directory: false,
	}),
);

const content = new TextEncoder().encode(JSON.stringify({ port: 8000 }));

await fileSystem.write(
	Client.createMessageValid(FileSystemPB.FileSystemServiceWriteRequestSchema, {
		fs: projectFs,
		target: "/config/app.json",
		content,
	}),
);

const result = await fileSystem.read(
	Client.createMessageValid(FileSystemPB.FileSystemServiceReadRequestSchema, {
		fs: projectFs,
		target: "/config/app.json",
	}),
);
console.log(new TextDecoder().decode(result.content));

await fileSystem.delete(
	Client.createMessageValid(FileSystemPB.FileSystemServiceDeleteRequestSchema, {
		fs: projectFs,
		path: "/config",
	}),
);
```

请求路径最长为 4096 个字符。使用以 `/` 开头、相对于所选项目或模板根目录的路径，能让调用意图更清楚。`read` 只接受普通文件。读取目录或超过 10 MiB 的文件会返回 `FailedPrecondition`；`write` 超过 10 MiB 会先被 Protobuf 校验拦截。

#### 下载文件或目录

`download` 的协议总是返回 ZIP。下载单个文件时，ZIP 内包含该文件。下载目录时，ZIP 内包含目录的内容。

当前服务端没有调用 Archiver 的 `finalize()`。根据 [Archiver API](https://www.archiverjs.com/docs/archiver/)，服务端必须调用该方法来结束归档。当前下载流可能不会结束，ZIP 也可能无效。服务端修复前不要在生产应用中使用 `download()`。修复后的调用方式如下：

```ts
import { once } from "node:events";
import { createWriteStream } from "node:fs";

const chunks = fileSystem.download(
	Client.createMessageValid(FileSystemPB.FileSystemServiceDownloadRequestSchema, {
		fs: projectFs,
		path: "/src",
	}),
);

const output = createWriteStream("project-src.zip");

try {
	for await (const { chunk } of chunks) {
		if (!output.write(chunk)) {
			await once(output, "drain");
		}
	}
	const finished = once(output, "finish");
	output.end();
	await finished;
} catch (error) {
	output.destroy();
	throw error;
}
```

#### 使用模板文件系统

用 manager client 访问模板目录，并把类型改为 `TEMPLATE`：

```ts
const templateFiles = managerClient.createFileSystemService();
const templateFs = Client.createMessageValid(FileSystemPB.FileSystemSchema, {
	type: FileSystemPB.FileSystemType.TEMPLATE,
	id: templateId,
});

await templateFiles.create(
	Client.createMessageValid(FileSystemPB.FileSystemServiceCreateRequestSchema, {
		fs: templateFs,
		target: "/README.md",
		directory: false,
	}),
);

await templateFiles.write(
	Client.createMessageValid(FileSystemPB.FileSystemServiceWriteRequestSchema, {
		fs: templateFs,
		target: "/README.md",
		content: new TextEncoder().encode("# Starter\n"),
	}),
);
```

### 3.6 文件分片上传（`FileUploadService`，尚未实现）

SDK 已导出 `createFileUploadService()` 和完整的分片上传协议。协议定义了以下流程：

```ts
// 当前只能获得协议客户端；服务端实现完成前不要发起调用。
const uploads = userClient.createFileUploadService();
```

| 方法 | 请求字段 | 协议含义 |
| --- | --- | --- |
| `create` | `fs`, `target`, `hash`, `size` | 创建上传。`hash` 是 32 字节 SHA-256，`size` 大于 0 |
| `upload` | `id`, `chunk`, `chunkIndex` | 上传 1 到 65536 字节的分片。`chunkIndex` 从 1 开始 |
| `complete` | `id` | 完成上传并校验结果 |
| `cancel` | `id` | 取消上传 |

当前 `FileUploadServiceImplementation` 没有注册任何处理函数。这四个方法都会返回 `Unimplemented`。不要在上层应用中调用它们。文件内容不超过 10 MiB 时，使用 `FileSystemService.write()`；更大的文件需等待服务端实现分片上传。

### 3.7 Supervisor：实例分配门户（`SupervisorPortalService`）

此服务仅能由 Supervisor 调用。进程每次启动都要生成一个 `processId`（1 到 64 个字符，例如 `randomUUID()`），并在该进程的整个生命周期内传给 `watch()`。协议会拒绝空的 `processId`。

`watch()` 是服务端流，返回 `AsyncIterable`，现在同时负责分配事件和 Supervisor 在线 lease；旧版 `heartbeat()` RPC 已移除。必须持续消费该流：服务端在流建立后创建 lease，并在服务端内部续租；流关闭时会立即使 lease 过期并销毁关联的隧道连接。10 秒 lease 超时是异常情况下的兜底，不需要客户端另发定时心跳。

每个 Supervisor 同时只能有一个活跃 watch。同一 `processId` 重复建立流会收到 `AlreadyExists`。新进程使用不同的 `processId` 连接时，服务端会关闭旧流、旧 lease 和旧隧道后接管。连接成功后先发送当前完整分配快照，分配变化时再次发送完整快照；队列为空时大约每 15 秒发送一次 keepalive。

```ts
import { randomUUID } from "node:crypto";
import { Client, SupervisorPortalPB } from "@aw/vm-director/sdk";

const portal = supervisorClient.createSupervisorPortalService();
const processId = randomUUID();
```

| 方法 | 请求字段 | 返回/作用 |
| --- | --- | --- |
| `watch` | `processId` | 服务端流，事件为 `keepalive` 或 `assignmentList`；同时维持在线 lease |
| `acknowledge` | `instanceId`, `status` | 接受或拒绝实例分配。分配等待确认的时限约为 15 秒 |
| `release` | `instanceId` | 通知实例已停止，释放调度容量 |

```ts
const watchAbort = new AbortController();
let resolveWatchReady!: () => void;
const watchReady = new Promise<void>((resolve) => {
  resolveWatchReady = resolve;
});

async function runWatch() {
  const stream = portal.watch(
    Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceWatchRequestSchema, {
      processId,
    }),
    { signal: watchAbort.signal },
  );

  for await (const event of stream) {
    // 首个事件意味着服务端已建立 lease；Promise resolve 可重复调用且只生效一次。
    resolveWatchReady();

    if (event.event.case === "keepalive") continue;
    if (event.event.case !== "assignmentList") continue;

    // list 是此 Supervisor 的完整当前分配快照，而不是增量。
    for (const assignment of event.event.value.list) {
      // confirmed=true 表示 Director 已经结算过该分配，只需恢复或校准本地状态，不能再次 acknowledge。
      if (assignment.confirmed) {
        await reconcileRunningInstance(
          assignment.instanceId,
          assignment.projectId,
          assignment.projectResourceTier,
        );
        continue;
      }

      let status: SupervisorPortalPB.AcknowledgeStatus;

      try {
        await ensureInstanceRunning(
          assignment.instanceId,
          assignment.projectId,
          assignment.projectResourceTier,
        );
        status = SupervisorPortalPB.AcknowledgeStatus.OK;
      } catch (error) {
        status = SupervisorPortalPB.AcknowledgeStatus.REJECT;
        logger.error("无法启动实例", { instanceId: assignment.instanceId, error });
      }

      await portal.acknowledge(
        Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceAcknowledgeRequestSchema, {
          instanceId: assignment.instanceId,
          status,
        }),
      );
    }
  }
}

// 必须监控该 Promise；流意外退出后应带退避重连，并沿用本进程的 processId。
const watchTask = runWatch();

// 本地实例停止时：
await portal.release(
  Client.createMessageValid(SupervisorPortalPB.SupervisorPortalServiceReleaseRequestSchema, {
    instanceId: "123456789012345678901234",
  }),
);

watchAbort.abort();
await watchTask.catch((error) => {
  if (!watchAbort.signal.aborted) throw error;
});
```

`Assignment` 含 `instanceId`、`projectId`、`projectResourceTier`、`confirmed` 和 `timestamp`。确认状态只能是 `AcknowledgeStatus.OK` 或 `REJECT`，不能是 `UNSPECIFIED`。只对 `confirmed === false` 的新分配调用 `acknowledge()`；重复确认会根据结算时序收到 `FailedPrecondition` 或 `NotFound`。网络中断后，应用应自行带退避重连 `watch()`，并继续使用同一个 `processId`；只有进程真正重启时才生成新的值。

## 4. 已认证访问项目 HTTP、SSE 与 WebSocket

用户可访问 `/link/:projectId/...`。Director 校验签名和项目 owner，为项目分配实例，去掉签名 header，并加入可信的 `x-instance-id` header 后通过隧道转发。缺少有效签名返回 `401`。身份不是 user 返回 `403`。项目不存在或不属于该用户返回 `404`。

`Client` 的公开 getter 名称当前为 `singer`（源码拼写如此）。它返回请求签名器，可为普通 HTTP/WS 握手写入签名 header：

```ts
async function signedHeaders(client: Client, init?: HeadersInit) {
  return await client.singer.apply(new Headers(init));
}

const response = await fetch(
  `https://director.example.com/link/${projectId}/api/health`,
  {
    headers: await signedHeaders(userClient, { accept: "application/json" }),
    signal: AbortSignal.timeout(15_000),
  },
);

if (!response.ok) throw new Error(`Project request failed: ${response.status}`);
console.log(await response.json());
```

浏览器原生 `WebSocket` 不能设置自定义请求头，因此不能直接使用它发起需要签名的连接。请在 Node.js 后端使用支持 handshake header 的 WebSocket 客户端，或经由自己的后端代理：

```ts
import WebSocket from "ws";

const ws = new WebSocket(`wss://director.example.com/link/${projectId}/socket`, {
  headers: Object.fromEntries((await signedHeaders(userClient)).entries()),
});

ws.on("message", (data) => console.log(data.toString()));
```

每个 HTTP 请求或 WebSocket 握手必须重新调用 `apply()`，以获得新的 nonce 和时间戳。被转发给项目应用的身份认证头已被 Director 移除；项目应用不应尝试验证 `x-request-signature`，而应把 `x-instance-id` 仅作为 Director 注入的路由上下文。

## 5. Supervisor 反向隧道（`TunnelClient`）

`TunnelClient` 取代了旧版本的固定 `project`、`token`、`target` 隧道配置。现在它以 Supervisor 身份连接 `${baseUrl}/tunnel`，并对每个转发请求调用 `targetResolver(headers)` 决定目标 URL。因此单个 Supervisor 可按 `x-instance-id` 将不同项目实例路由至不同本地服务。

`/tunnel` 要求该 Supervisor 已经通过正在消费的 `watch()` 流拿到 lease。没有 lease 时升级返回 `503`，SDK 会记录 warning 并在约 2 秒后重连。应先启动并持续消费 `watch()`，确认收到第一个 `assignmentList` 或 `keepalive` 事件后，再调用 `tunnel.start()`。watch 流关闭会使 lease 失效并拆掉现有隧道 socket；恢复 watch 后，同一个 `TunnelClient` 会按约 2 秒间隔自行重连，不必再次调用 `start()`。

```ts
import { TunnelClient } from "@aw/vm-director/tunnel";

const controller = new AbortController();

const tunnel = new TunnelClient({
  // Director HTTP 根地址，不能带 /grpc 或 /tunnel。
  baseUrl: "https://director.example.com",
  identity: {
    type: "supervisor",
    id: process.env.DIRECTOR_SUPERVISOR_ID!,
    privateKey: process.env.DIRECTOR_SUPERVISOR_PRIVATE_KEY_HEX!,
  },
  // 每条连接对应一个可并行处理的隧道槽位。
  maxConnections: 10,
  // 接收包含 Director 注入的 x-instance-id 在内的完整请求头。
  targetResolver: async (headers) => {
    const instanceId = headers.get("x-instance-id");
    if (!instanceId) throw new Error("Director did not provide x-instance-id");

    const instance = await localRuntime.waitUntilReady(instanceId);
    return new URL(`http://${instance.ip}:8000`);
  },
  logger: {
    debug: (message, context) => console.debug(message, context),
    info: (message, context) => console.info(message, context),
    warn: (message, context) => console.warn(message, context),
    error: (message, context) => console.error(message, context),
  },
});

// watchReady 来自 3.7 节；收到首个事件后 lease 已建立。
await watchReady;
tunnel.start(controller.signal);
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
```

`targetResolver` 支持同步或异步返回 `URL`，可按任意请求头路由。SDK 使用 `http-proxy-middleware` 代理 HTTP、带流的 SSE 和 WebSocket，且会以目标 URL 的 origin 重写 `Host`（`changeOrigin: true`）。来自 Director 的其它请求头会转发给目标服务。

| `TunnelClient.Options` | 含义 |
| --- | --- |
| `baseUrl: string` | Director HTTP 根 URL |
| `identity` | 必须为可通过认证的 supervisor 身份；manager/user 会被 `/tunnel` 拒绝。没有活跃 watch lease 时升级返回 `503` |
| `dev?: boolean` | 使用开发签名 header，仅限非生产 Director |
| `targetResolver(headers)` | 每个被代理的请求/升级连接选取目标 URL |
| `maxConnections: number` | 要长期维持的并行隧道连接数 |
| `logger` | 必须实现 `debug/info/warn/error(message, context)` |

`start(signal)` 立即在后台启动连接，不返回“连接成功”的 Promise；同一实例只能调用一次。升级失败、连接关闭或代理连接出错时，SDK 会记录 warning 并在约 2 秒后重连。`AbortController.abort()` 会关闭连接并停止重试；如需重新启动，请创建新的 `TunnelClient`。

目标解析或代理失败时，该请求/升级会收到 `502`，而不是终止整个连接池。为避免影响其它实例，`targetResolver` 应快速失败或带上合理超时。

## 6. 错误处理与实施建议

Connect RPC 错误以 `ConnectError` 抛出；HTTP 项目访问则使用标准 HTTP 状态码。

```ts
import { Code, ConnectError } from "@connectrpc/connect";

try {
  await projects.get(Client.createMessageValid(ProjectPB.ProjectServiceGetRequestSchema, { id: projectId }));
} catch (error) {
  if (error instanceof ConnectError) {
    switch (error.code) {
      case Code.Unauthenticated:
        // 检查私钥是否为完整 PKCS#8 DER 的 hex、时钟和环境模式。
        break;
      case Code.PermissionDenied:
        // 当前 identity 无权调用该服务。
        break;
      case Code.NotFound:
        // ID 不存在、已删除，或项目并非当前用户所有。
        break;
      case Code.AlreadyExists:
        // 同一 processId 上已经有活跃的 watch 流。
        break;
      case Code.FailedPrecondition:
        // 例如读取目录、删除文件系统根目录、删除在线 Supervisor，或对已结算的分配再次 acknowledge。
        break;
      case Code.InvalidArgument:
        // 例如 FileSystem.type 为 UNSPECIFIED，或 watch 缺少 processId。
        break;
      case Code.Unimplemented:
        // 当前版本尚未实现 move、copy 和 FileUploadService。
        break;
      case Code.Unavailable:
        // Director 未配置文件系统根目录，或服务暂时不可用。
        break;
    }
  }
  throw error;
}
```

- 创建 user/supervisor 后立刻将私钥存入密钥管理服务；服务端之后不会再返回私钥。
- 保持客户端和 Director 时钟同步。生产签名的有效时间窗为 5 分钟。
- 用 `AbortController` 统一管理 RPC 超时、watch 生命周期和 tunnel 退出。
- Supervisor 进程启动时生成一次 `processId` 并传给 `watch()`。不要传空字符串；同一进程重连时复用它，进程重启时再生成新值。
- 持续消费 `watch()` 以维持 lease，并在收到首个事件后启动 `TunnelClient`。watch 关闭会使 Supervisor 离线并断开现有隧道。
- 不要传 `UNSPECIFIED` 枚举值；资源档位、模板状态、确认状态均会被协议校验拒绝。
- RPC 不会由 SDK 自动重试。对于创建、删除、确认等变更操作，请由上层按业务幂等性实现重试。

## 7. 当前版本边界

1. `ProjectServiceLaunchRequest` 和 `ProjectServiceLaunchResponse` 存在于 proto 文件中，但 `ProjectService` descriptor、SDK client 和服务端路由均没有 `launch()`。当前不可调用该方法。
2. `FileSystemService.move()` 和 `FileSystemService.copy()` 存在于 proto 和 SDK client 中，但服务端未注册处理函数。当前调用会返回 `Unimplemented`。
3. `FileUploadService` 的 `create()`、`upload()`、`complete()` 和 `cancel()` 均存在于 proto 和 SDK client 中，但服务端未注册处理函数。当前调用会返回 `Unimplemented`。
4. `UserService.list.disabled`、`SupervisorService.list.disabled` 和 `TemplateService.list.status` 已出现在请求定义中，但当前服务端 list 实现尚未使用这些字段过滤数据。调用可以成功，筛选请暂时在上层完成。
5. `SupervisorService.list()` 返回的数组会按 manager 平台范围或当前 user owner 范围过滤，但 `total` 当前统计所有未删除节点，可能与可访问记录数不一致。
6. `ProjectService.create.name`、`supervisorId` 和 `workspace` 会通过协议校验，但当前实现不会持久化或返回这些字段，调度器也不会按 `supervisorId` 固定节点。名称请同时写入 `metadata`，其余两个字段暂勿依赖。
7. `FileSystemService.download()` 没有调用 Archiver 的 `finalize()`。当前下载流可能不会结束，也可能无法生成有效 ZIP。
8. `TreeNode` 协议包含 `symlink` 类型，但当前目录扫描使用 `stat()`。符号链接可能按其目标类型返回，不能依赖 `symlink` 分支识别符号链接。
9. `Client.singer` 是当前 SDK 的真实公开属性名。它的拼写是 `singer`，不是 `signer`。该属性用于给普通 HTTP 和 WebSocket 请求签名。

如果你从仓库源码构建 SDK，在拉取 proto 变化后必须运行以下命令。`services/director/src/generated` 被 Git 忽略；未重新生成时，本地类型可能仍包含已移除的 `heartbeat()`/`Load`，或缺少新的 Project 字段。

```bash
pnpm --filter @aw/vm-director generate
```
