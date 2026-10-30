# Agent Worker

[English](README.md) | 简体中文

Agent Worker 是面向代码型 AI Agent 的自托管执行基础设施。它将用户、项目和模板管理放在 Director 控制面，将 Linux MicroVM 的创建、资源限制和回收放在 Supervisor 执行节点，并提供请求签名、文件操作、反向隧道和 Web 终端等组件，供上层 Agent 产品集成。

项目希望解决的是：如何为不同用户的代码任务分配独立运行环境，让任务拥有工作目录、受限的计算资源以及可访问的终端和服务，同时由宿主机管理这些环境的生命周期。运行时镜像目前内置 `pi-coding-agent`，可以通过修改镜像构建脚本和入口替换目标程序。

**当前版本为 `0.0.1`，处于架构重构与集成阶段。仓库包含可单独开发的组件，但尚不能从干净检出直接启动完整的 Director → Supervisor → MicroVM 工作流。** 下文分别说明已有实现、实际配置和当前阻塞；请先阅读这些边界，再尝试运行服务。

## 导航

- [已有能力与当前边界](#已有能力与当前边界)
- [架构与目录](#架构与目录)
- [开发环境与首次准备](#开发环境与首次准备)
- [Director 配置与使用](#director-配置与使用)
- [Supervisor 与运行时镜像](#supervisor-与运行时镜像)
- [检查与测试](#检查与测试)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

## 已有能力与当前边界

这里的“已有实现”指源码中存在相应逻辑，不代表完整服务已通过端到端验证。

| 能力 | 已有实现 | 当前边界 |
| --- | --- | --- |
| 控制面 | 用户、Supervisor、模板、项目及文件系统 RPC；MySQL/Drizzle 数据层与迁移 | Director 构建入口和部分历史代码尚未完成迁移 |
| 身份认证 | Manager、User、Supervisor 三类身份；Ed25519 签名、时间窗与 Redis nonce 防重放 | 非生产模式允许开发身份头，必须使用可信的开发环境 |
| 项目与模板文件 | 创建、读写、目录树、删除、移动、复制等 RPC | ZIP 下载缺少归档结束调用；分片上传仅有协议与 SDK 入口 |
| 调度 | 容量、部署数据模型；历史分配器；`Watch / Acknowledge / Release` 协议 | 新 `Scheduler` 是空实现；Portal 尚无服务端处理器，Supervisor 也未消费分配 |
| MicroVM | Firecracker/jailer、network namespace、TAP/veth、nftables、CPU/内存 cgroup、只读根与可写 OverlayFS | Supervisor 入口直接创建一个随机 ID 的 `minimal` 演示 VM |
| 工作区 | Supervisor 文件系统、NFS-Ganesha 动态导出组件、独立 Go WebDAV 服务 | 工作区导出尚未接入当前演示 VM；不能依赖宿主项目文件自动出现在 `/workspace` |
| 远程访问 | Director 隧道组件、SDK `TunnelClient`、独立 `@aw/tunnel` 通信库 | Director 隧道服务未被启动入口实际解析；`/link` 转发处理器仍为空 |
| Web 终端 | Go `ptyd`：PTY、HTTP 页面、WebSocket、终端状态恢复与空闲退出 | 当前 VM 入口固定在 `8000` 端口启动 `pi`，需要自行提供模型配置 |

当前没有可直接使用的管理面板，也没有完整的 Agent 任务 API。`ProjectService` 没有 `Launch` RPC；创建项目不等于启动 VM。旧 README 中的 BullMQ/Fetch 流程、独立 HTTP/2 TLS 端口，以及 `runner`、`vm-agent`、`vm-manager` 等目录均不适用于当前仓库。

## 架构与目录

实线表示当前模块依赖或本地运行路径，虚线表示尚待接通的集成关系。

```mermaid
flowchart LR
  Client["上层产品 / TypeScript SDK"] --> API["Director<br/>HTTP + Connect /grpc"]
  API --> DB[("MySQL / Drizzle<br/>用户、节点、模板、项目、部署")]
  API --> Redis[("Redis<br/>缓存、签名 nonce")]
  API --> Files["Director 项目 / 模板目录"]
  API -. "调度、分配与隧道待集成" .-> Supervisor["Supervisor / VMFactory"]
  Supervisor --> Host["Linux KVM<br/>jailer、cgroup、独立网络"]
  Host --> VM["MicroVM<br/>SquashFS + ext4 / OverlayFS"]
  VM --> Terminal["ptyd :8000 → pi"]
  Workspace["NFS-Ganesha / WebDAV 组件"] -. "工作区挂载待集成" .-> VM
```

```text
.
├── services/
│   ├── director/
│   │   ├── src/api/            # RPC 与隧道处理器
│   │   ├── src/internal/       # 数据、认证、文件、隧道等服务
│   │   ├── src/sdk/            # 签名客户端和 TunnelClient
│   │   ├── proto/              # 对外 API 协议
│   │   └── drizzle/migrations/ # MySQL 迁移
│   └── supervisor/
│       ├── src/internal/       # VM、镜像、网络、NFS、文件等组件
│       ├── proto/              # 执行节点文件与部署协议
│       ├── resources/          # VM init、entrypoint、应用测试资源
│       └── scripts/            # 镜像构建、Firecracker 下载与代码生成
├── native/
│   ├── ptyd/                   # Go Web 终端及 Linux 双架构二进制导出
│   └── webdav/                 # Go WebDAV 与 Unix Socket 控制接口
├── packages/
│   ├── container/              # 依赖注入、初始化和释放生命周期
│   ├── environment/            # 带前缀的环境变量与 dotenv 加载
│   ├── logging/                # Pino 日志封装
│   ├── proto/                  # Protobuf 类型、服务抽象与注册表
│   ├── proto-codegen/          # 自定义 Protobuf TypeScript 生成插件
│   ├── tunnel/                 # Socket pair、HTTP/2 隧道与流桥接
│   └── shared-config-typescript/
├── docker/                     # 尚待同步的 Director / Supervisor Dockerfile
├── docs/SDK_USAGE_GUIDE.md      # SDK 详细示例，部分描述已落后于重构
├── pnpm-workspace.yaml
└── package.json
```

主要技术栈为 TypeScript、Node.js、pnpm workspace、ConnectRPC、Protobuf/Buf、Drizzle/MySQL、Redis，以及 Go、Firecracker 和 Linux 网络工具。根目录构建使用 pnpm 递归脚本；仓库也保留了 Turbo 配置。

## 开发环境与首次准备

### 环境要求

| 开发内容 | 需要的环境 |
| --- | --- |
| TypeScript 组件、SDK、控制面开发 | 建议 Node.js 24；根 `packageManager` 指定 `pnpm@11.18.0` |
| Go 组件与全仓库构建 | 建议 Go 1.27 或兼容工具链；`ptyd/go.mod` 声明 `1.27.0`，`webdav/go.mod` 声明 `1.26.1` |
| Director 运行与数据库集成测试 | MySQL、Redis、可写文件目录；数据库测试辅助工具当前指定 MySQL `9.7.2`、Redis `8.10.2` |
| Supervisor / MicroVM | Linux x86_64 或 aarch64、可用的 `/dev/kvm`、cgroup、root 或等效宿主权限 |
| VM 镜像构建 | Linux、Bash、Buildah、`mksquashfs`、Node.js/npm、pnpm，以及镜像与包下载网络 |

仓库没有通过 `engines` 声明统一的 Node.js 最低版本；Node.js 24 与现有 Dockerfile 的主版本一致。子包仍有 `pnpm@10.14.0` 字段，开发时以根目录版本为准。macOS 可以开发 TypeScript 和部分 Go 组件；完整 Firecracker 链路需要 Linux/KVM，Windows 开发建议使用 Linux 环境。

### 安装与独立组件构建

克隆仓库或自己的 fork 后，在仓库根目录执行：

```bash
pnpm install --frozen-lockfile

# 先构建不依赖 VM 的共享组件，供服务和代码生成器引用。
pnpm --filter @aw/container --filter @aw/environment --filter @aw/logging \
  --filter @aw/proto --filter @aw/proto-codegen --filter @aw/tunnel -r build

# 可以先从不依赖数据库或虚拟机的测试开始。
pnpm --filter @aw/container test --run
```

非 CI 安装会执行 `lefthook install`，安装 pre-commit 检查钩子。依赖安装、Buf 依赖和原生工具链首次准备可能需要网络。

### 生成协议和 Firecracker 客户端

生成文件被服务目录的 `.gitignore` 忽略，干净检出后需要生成。先完成上述共享组件构建，确保本地 `proto-codegen` 插件可执行，再运行：

```bash
# Director 扩展类型与 API 类型。
pnpm --filter @aw/vm-director exec buf generate --template buf.gen.extensions.yaml
pnpm --filter @aw/vm-director gen:proto

# Supervisor 协议与 Firecracker OpenAPI 客户端。
pnpm --filter @aw/vm-supervisor gen:proto
pnpm --filter @aw/vm-supervisor generate:firecracker-api
```

`gen:proto` 包含独立的 registry 生成脚本。Firecracker OpenAPI 生成器会从 GitHub 查询最新 release，因此生成结果并未固定到特定 Firecracker 版本；修改相关代码时应核对生成客户端与实际二进制版本。

这些命令是生成步骤，**不能修复所有重构遗留问题**。例如 Director 仍有旧 `Repository`、日志和密钥模块引用，且构建配置指向不存在的 `src/index.ts`，实际启动入口为 `src/main.ts`。不要把旧的 `pnpm --filter @aw/vm-director generate` 当作生成命令：当前包没有这个脚本。

## Director 配置与使用

### 配置

当前 Director 使用同一个 HTTP 端口，默认为 `3008`，Connect API 路径前缀为 `/grpc`。适配器只启用 Connect，**没有启用原生 gRPC 或 gRPC-Web，也没有内建 TLS 监听器**。远程部署需要在入口代理配置 HTTPS。

`Environment` 先加载其根目录下的 `.env`，根据 `NODE_ENV` 确定模式，再加载 `.env.<mode>`；已有进程变量优先；未注入的配置由模式文件覆盖基础文件。Director 的根目录是进程工作目录，使用 `pnpm --filter @aw/vm-director dev` 时应把配置放在 `services/director/.env`。

```dotenv
# services/director/.env —— 以下都是示例值，请替换。
NODE_ENV=production
AW_DIRECTOR_DATABASE_URL=mysql://aw:replace-me@127.0.0.1:3306/agent_worker
AW_DIRECTOR_DATABASE_MIGRATIONS=./drizzle/migrations
AW_DIRECTOR_REDIS_URL=redis://127.0.0.1:6379/0
AW_DIRECTOR_FS_ROOT=/tmp/agent-worker-director-files
AW_DIRECTOR_HTTP_PORT=3008
# 使用真实签名的 manager 客户端时设置：
# AW_DIRECTOR_MANAGER_PUBLIC_KEY=<Ed25519 SPKI DER 的十六进制字符串>
```

| 配置 | 实际作用 |
| --- | --- |
| `AW_DIRECTOR_DATABASE_URL` | 必填，MySQL 连接串；旧 `AW_DIRECTOR_MYSQL_URL` 已不适用 |
| `AW_DIRECTOR_DATABASE_MIGRATIONS` | 必填，迁移目录；相对路径以进程工作目录解析 |
| `AW_DIRECTOR_REDIS_URL` | 必填，Redis 连接串 |
| `AW_DIRECTOR_FS_ROOT` | 文件服务需要，项目与模板目录的根路径 |
| `AW_DIRECTOR_HTTP_PORT` | 可选，默认 `3008` |
| `AW_DIRECTOR_MANAGER_PUBLIC_KEY` | 验证 manager 签名需要的公钥 hex；服务端不需要 manager 私钥 |
| `NODE_ENV` | 默认 `development`；只有 `production` 会禁用开发身份头 |

先创建连接串中指定的 MySQL 数据库、启动 Redis，并为文件根目录提供写权限。数据库初始化会自动执行迁移，不需要另行运行 Prisma 命令。修改表结构时使用 `pnpm --filter @aw/vm-director gen:db` 生成 Drizzle 迁移，并审查 SQL。

修复构建与协议集成阻塞后，开发启动命令为：

```bash
pnpm --filter @aw/vm-director dev
```

构建后的启动脚本为 `pnpm --filter @aw/vm-director start`，依赖 `dist/index.cjs`。当前不能跳过构建入口修复直接使用它。

### SDK 接入方式

SDK 源码与 Director 位于同一包，提供 `@aw/vm-director/sdk` 和 `@aw/vm-director/tunnel` 两个导出入口。建议先在 workspace 内构建与调试；仓库中的包定义不代表已有可用的 npm 发布版本。

下面展示真实签名客户端的基本形式，需要先修复并构建 Director 包，并有可运行的服务端和已登记用户：

```ts
import { createConnectTransport } from "@connectrpc/connect-node";
import { Client, ProjectPB } from "@aw/vm-director/sdk";

const client = new Client(
  createConnectTransport({
    baseUrl: "http://127.0.0.1:3008/grpc",
    httpVersion: "1.1",
  }),
  {
    type: "user",
    id: process.env.DIRECTOR_USER_ID!,
    privateKey: process.env.DIRECTOR_USER_PRIVATE_KEY_HEX!,
  },
);

const result = await client.createProjectService().list(
  Client.createMessageValid(ProjectPB.ProjectServiceListRequestSchema, {
    page: 1,
    pageSize: 20,
  }),
);
console.log(result);
```

示例中的 `DIRECTOR_USER_*` 是调用方自行读取的变量，不是 Director 服务端配置。身份私钥采用 PKCS#8 DER 的 hex；Manager 公钥采用 SPKI DER 的 hex。SDK 会逐请求生成签名、nonce 和时间戳。Manager 通过 `UserService` 创建用户，用户再管理自己的项目；创建身份返回的私钥应立即安全保存，不应发送到浏览器。

更多调用示例见 [Director SDK 使用指南](docs/SDK_USAGE_GUIDE.md)。**该指南尚未同步本轮重构**：其中 gRPC-Web、Portal/watch、`/link`、部分文件 RPC 状态及 `generate` 命令的描述，应以当前源码和本 README 的边界为准。SDK 暴露一个方法不代表服务端已注册它。普通 HTTP 请求签名器的公开属性目前拼写为 `client.singer`。

### 尚需完成的控制面积成

- `Scheduler` 仍为空类；历史 `Allocator` 依赖已移除的模块，未接入当前 Drizzle 数据层。
- `SupervisorPortalService` 只有 proto 和 SDK 客户端，当前没有服务端实现。
- `SupervisorTunnelService` 虽在容器中注册为 provider，但没有被入口依赖实际解析；容器会移除未使用的 provider。即使接入该服务，其 `/link` HTTP/Upgrade 处理器也尚为空。
- 文件 `move/copy` 已有服务端处理逻辑；`FileUploadService` 尚未注册，ZIP `download` 未调用 `finalize()`，不应依赖下载流正常结束。

## Supervisor 与运行时镜像

Supervisor 当前用于验证本地 VM 启动，入口只依赖 `VMFactory`，不会连接 Director、上报指标或处理项目分配。NFS-Ganesha、HTTP/RPC Server 和 LMDB 组件虽已有实现及 provider 定义，尚未被该入口的依赖树实际启用。

### 准备宿主机和构建产物

请在专用 Linux/KVM 开发机运行。VM 网络初始化会修改宿主 IP 转发和 nftables，并清理该模块管理的旧 network namespace；jailer 需要设备、cgroup 和目录权限。相关工具包括 `ip`、`nft`、`sysctl`、`truncate`、`mkfs.ext4`，以及同架构的 `firecracker`、`jailer` 和 `vmlinux`。

完成依赖、协议和 OpenAPI 生成后，可准备如下产物。以下命令在仓库根目录执行：

```bash
# 下载当前宿主架构的 Firecracker、jailer 和 CI kernel。
# 脚本依赖 curl、wget、tar 和支持 -P 的 GNU grep。
bash services/supervisor/scripts/download-firecracker-ci.sh /tmp/aw-firecracker-artifacts

# 构建 Linux amd64/arm64 的 ptyd 二进制。
pnpm --filter @aw/ptyd build

# 提供明确的二进制路径，避免镜像脚本默认的包查找路径差异。
# aarch64 宿主机改为 ptyd-linux-arm64。
PTYD_SOURCE="$PWD/native/ptyd/dist/ptyd-linux-amd64" \
  bash services/supervisor/scripts/build-runtime-image.sh /tmp/aw-runtime.squashfs
```

镜像脚本使用 Buildah 的 rootless 模式，需要配置 subordinate UID/GID 和兼容的存储驱动。它会下载 Alpine 软件包并安装 `@earendil-works/pi-coding-agent`；这些上游版本当前未全部固定。Supervisor 启动时只验证已有 `runtime.squashfs`，不会自动构建镜像。

### 配置与演示入口

Supervisor 的环境根目录在入口中固定为 `/aw-supervisor`，会从这里读取 `.env`，并在该目录下创建 jailer 等运行目录。当前实际 VM 路径使用的配置为：

```dotenv
# /aw-supervisor/.env
AW_SUPERVISOR_FIRECRACKER_ARTIFACTS=/tmp/aw-firecracker-artifacts
AW_SUPERVISOR_RUNTIME_IMAGE=/tmp/aw-runtime.squashfs
```

运行镜像未设置时默认查找 `/aw-supervisor/images/runtime.squashfs`。`AW_SUPERVISOR_FS_ROOT` 属于文件系统组件配置；`AW_SUPERVISOR_SERVER_HOST`、`AW_SUPERVISOR_SERVER_PORT` 属于尚未接入入口的 HTTP Server（默认端口 `3000`），均不代表 VM 内的应用监听地址。身份凭据应放在本地环境文件中；当前 Supervisor 入口尚无读取它们的 Director 连接逻辑。

宿主权限和产物就绪后，演示入口命令为：

```bash
pnpm --filter @aw/vm-supervisor dev
```

当前 VM 资源规格为：

| `machineTier` | vCPU | Guest 内存 |
| --- | --- | --- |
| `minimal` | 1 | 256 MiB |
| `standard` | 2 | 512 MiB |
| `performance` | 4 | 1024 MiB |

jailer 的内存 cgroup 另加 `64 MiB` VMM 预算；每次 VM 创建默认 `512 MiB` 的可写 scratch 磁盘。这些是 `VMFactory` 的当前值，尚未与 Director 的资源枚举自动衔接。

VM 内使用 SquashFS + ext4/OverlayFS，init 脚本包含 capability 收缩与可选 NFS 挂载逻辑。应用入口启动 `ptyd --port 8000 --idle-timeout 10s --command /usr/local/bin/pi --dir /workspace -- --continue`。当前演示不注入项目工作区、模型凭据或 NFS 配置；运行真实 Agent 任务仍需完成这些集成。

### Docker 状态

[Director Dockerfile](docker/Dockerfile.director) 和 [Supervisor Dockerfile](docker/Dockerfile.supervisor) 可作为部署结构参考，目前不能当作开箱即用的部署方案：它们仍调用不存在的 Director `generate` 脚本；数据库凭据需在运行时注入，Supervisor 镜像的资源复制路径也需要与镜像脚本同步。仓库没有提供 Docker Compose 或完整部署编排。

## 检查与测试

TypeScript 包使用 Vitest，Go 测试需要单独运行。多数 `test` 脚本默认进入 watch 模式，单次检查应加 `--run`：

```bash
# 按变更范围选择包；服务检查前先构建共享依赖并生成代码。
pnpm --filter @aw/container typecheck
pnpm --filter @aw/container test --run
pnpm --filter @aw/tunnel test --run
pnpm --filter @aw/vm-director typecheck
pnpm --filter @aw/vm-supervisor typecheck

# 全部 TypeScript 测试与构建；当前存在下述已知失败。
pnpm test --run
pnpm build

# Go 测试不包含在根 pnpm test 中。
go -C native/ptyd test ./...
go -C native/webdav test ./...

# 只检查改动涉及的源码，避免自动改写全仓库。
pnpm exec biome check path/to/changed-file.ts
```

Director 的数据库测试会通过 `mysql-memory-server` 和 `redis-memory-server` 启动真实进程，首次可能下载二进制；隧道测试需要本地 TCP/Unix Socket 监听权限。只有宿主网络/KVM 环境就绪后，才能验证 VM 的启动、失败清理和退出行为。根 `pnpm lint`、`pnpm format` 带 `--write`，运行前应留意它们会修改文件。

本 README 重写时（2026-10-30）的有限验证结果：

- 六个共享组件的构建通过，`@aw/container` 的 27 项测试通过。
- `@aw/tunnel` 在允许本地 socket 监听后，83 项测试通过、1 项失败：extended CONNECT 的 `:protocol` 实际为 `http`，测试期望 `tcp`。
- Director 构建失败于不存在的 `src/index.ts`；类型检查仍有历史模块引用等错误。
- Supervisor 类型检查缺少尚未生成的协议 registry 和 Firecracker OpenAPI 文件；未在 Linux/KVM 上验证运行。

这些结果不是全仓库测试通过的声明。仓库当前也没有 CI workflow，应在 PR 中明确记录验证范围和已有失败。

## 参与贡献

欢迎提交问题、复现用例、文档改进和实现。建议先阅读对应服务的 `src/application.ts`，了解实际解析的依赖，再沿 API/proto、内部服务和测试定位行为。

### 建议的贡献方向

1. **恢复干净检出的可构建性**：统一入口、生成步骤、遗留模块和包版本；同步 Dockerfile 与 SDK 指南。
2. **完成部署调度闭环**：迁移历史分配逻辑、实现 Portal，连接 Supervisor 与 VM 生命周期，覆盖断线和重启恢复。
3. **接通工作区与运行时配置**：确定 NFS/WebDAV 的职责，将项目目录、资源规格与 Agent 配置传入 VM。
4. **完善访问与文件能力**：接入隧道与项目路由、补全分片上传和 ZIP 下载，验证权限与路径边界。
5. **补齐可靠性验证**：处理已有测试失败，建立 CI 和 Linux/KVM 集成测试，覆盖初始化失败、取消和资源回收。

这些方向来自当前代码缺口，不代表承诺的发布路线。较大的协议或架构调整，请先通过 Issue 说明问题、方案和兼容性影响，便于协调。

### 提交 Issue 和 Pull Request

- Bug 报告请提供复现步骤、预期/实际结果、相关提交、系统与架构、工具链版本，以及脱敏后的错误日志；VM 问题补充 KVM、cgroup 和 Firecracker 信息。
- 开发时 fork 仓库并建立独立分支，尽量让一个 PR 聚焦一个问题。提交说明写清楚改了什么、为什么，以及如何验证。
- 修改行为时补充相应测试；修改 API 时同步 `.proto`、服务端处理器、SDK 和文档。生成目录已被忽略，应修改协议或生成器并说明重新生成步骤。
- 修改数据库 schema 时一并提交经审查的 Drizzle 迁移；不要只更新本地数据库。
- 提交前运行相关包的构建、类型检查和测试。因已有阻塞未通过时，附上失败命令及原因；不要把未运行的检查标成通过。
- pre-commit 钩子会对暂存文件执行 Biome 检查并重新暂存自动修复结果，提交前请检查最终差异。

### 凭据与安全问题

真实凭据保存在本地环境文件中。将 [services/director/.env.example](services/director/.env.example) 复制为 `services/director/.env`，用于服务端配置；将 [.env.manager.example](services/director/.env.manager.example) 复制为 `services/director/.env.manager`，仅供可信的管理脚本使用。Director 服务端只需要 Manager 公钥，不应接收 Manager 环境文件，镜像构建也不应使用该文件。Supervisor 从 `/aw-supervisor/.env` 读取配置，可参考[配置模板](services/supervisor/.env.example)。真实环境文件应限制为仅所有者可读写（`chmod 600`）。

Git 会忽略 `.env` 和 `.env.*`，仅允许提交 `.env.example`、`.env.*.example` 模板；Docker 构建上下文会排除所有环境文件变体、私钥文件和 Git 元数据。这些规则无法保护已经被 Git 跟踪的秘密。不要提交私钥、模型 API key、数据库密码、真实用户工作区或未脱敏日志。生产配置应在运行时注入，例如通过 Docker 的 `--env-file`；设置 `NODE_ENV=production` 才会禁用不验签的开发身份头。

创建 Supervisor 的管理脚本从 `.env.manager` 读取配置，使用 Connect 和真实签名，远程端点必须使用 HTTPS。返回的身份凭据会写入新建的本地环境文件，权限仅限所有者，不再打印私钥，也不会覆盖已有输出文件。当前 Supervisor 演示入口尚未消费这些身份配置。

运行 `pnpm security:scan` 检查工作区，运行 `pnpm security:scan:history` 检查可达 Git 历史。检查仅输出位置，不输出敏感值；规则覆盖已知凭据格式，扫描通过不代表完成了全面安全审计。**本次开源前审查在历史版本中发现了身份私钥和 TLS 私钥。将当前值迁入环境文件，并不会使旧密钥失效，也不会删除历史提交。** 公开前必须轮换相关凭据、更换 TLS 证书与私钥，并清理所有待发布 ref 的敏感历史，或另行发布经审查的干净快照。生产依赖审查也仍有未解决项。范围及剩余事项见[审查记录](docs/SECURITY_REVIEW.md)。

涉及认证绕过、宿主逃逸、路径越界或凭据泄漏时，请私密报告。优先使用托管平台已启用的私密漏洞报告渠道；若未启用，先联系维护者建立私密渠道。不要在公开 Issue 中附上可用凭据或攻击细节。报告说明见 [SECURITY.md](SECURITY.md)。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。运行时使用和下载的第三方组件遵循各自许可证；分发镜像或二进制时也应保留其要求的许可与声明。欢迎在该许可证下参与贡献。
