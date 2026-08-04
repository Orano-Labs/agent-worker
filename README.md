# Agent Worker

Agent Worker 是面向代码型 AI Agent 的隔离执行基础设施。它负责把“启动一个项目运行环境”拆成可调度、可认证、可隔离、可限额、可回收的执行流程，而不是提供聊天界面或完整 Agent 产品。

项目目前处于 **原型集成阶段（v0.0.x）**：控制面、调度、MicroVM、共享工作区和通信组件已有实现，但端到端任务派发尚未接通，不应直接用于生产环境。

## 它解决什么问题

- 让不同用户和项目运行在独立的 Firecracker MicroVM 中。
- 为任务限制 CPU、内存、文件系统和网络边界。
- 在多台宿主机之间登记 Supervisor、排队并分派项目。
- 让 MicroVM 通过受控的 WebDAV 工作区读写项目文件。
- 通过签名请求和反向隧道连接控制面、执行节点与项目实例。

## 架构

```mermaid
flowchart LR
  Client["上层产品 / SDK"]
  Director["Director<br/>ConnectRPC API · 认证 · 调度"]
  MySQL[("MySQL<br/>用户/模板/项目/节点")]
  Redis[("Redis + BullMQ<br/>队列/状态/Nonce")]
  Supervisor["Supervisor<br/>宿主机执行节点"]
  WebDAV["Native WebDAV<br/>按任务暴露工作区"]
  VM["Firecracker MicroVM<br/>只读镜像 + 可写 OverlayFS"]
  App["Runner App<br/>VM 内目标进程"]

  Client -->|"HTTP/2 + TLS + 签名"| Director
  Director --> MySQL
  Director --> Redis
  Supervisor -->|"指标上报 / 拉取任务"| Director
  Director <-->|"项目反向隧道"| Supervisor
  Supervisor --> WebDAV
  Supervisor --> VM
  WebDAV -->|"davfs2 / Basic Auth"| VM
  VM --> App
```

一次完整的目标流程如下；虚线部分代表代码存在，但尚未在 Supervisor 主流程中接通：

```mermaid
sequenceDiagram
  participant U as 上层产品
  participant D as Director
  participant Q as BullMQ
  participant S as Supervisor
  participant V as MicroVM

  U->>D: ProjectService.Launch
  D->>Q: 项目入队
  S->>D: SupervisorPortal.Fetch
  D-->>S: projectId + tunnel token
  S-->>V: 创建网络、工作区与 MicroVM
  V-->>D: 通过 Supervisor 建立项目隧道
  Note over S,V: 当前 Fetch → Orchestrator 尚未集成
```

## 核心模块

| 模块 | 职责 | 当前状态 |
| --- | --- | --- |
| `services/director` | ConnectRPC 控制面；用户、模板、项目、Supervisor API；签名认证；BullMQ 调度；项目隧道 | 主体已实现 |
| `services/supervisor` | 初始化宿主环境、网络与镜像；上报资源；创建和回收 Firecracker 任务 | 能运行演示 VM，尚未消费 Director 任务 |
| `native/webdav` | Go WebDAV 服务；通过 Unix Socket 动态创建/删除带凭据的项目暴露 | 已接入 Supervisor |
| `services/runner` | 未来的 VM 内 Agent Runner | 仅空入口与构建骨架 |
| `packages/rpc` | 支持普通调用、流式传输、取消和错误编码的 Socket.IO RPC | 有核心实现与流测试 |
| `packages/vm-agent` | 较早期的项目 bare repo、session worktree 和文件 RPC 实验 | 独立原型，未接入当前 MicroVM 链路 |
| `packages/vm-manager` | 较早期的 Firecracker/SSH/网络管理封装 | 独立原型 |
| `packages/vm-manager-panel` | Next.js 管理界面 | 仅显示本地环境状态 |
| `packages/vm-registry` | VM 注册能力占位 | 空包 |

## 关键实现

### 控制面与认证

Director 在两个端口提供服务：

- HTTP（默认 `3008`）：项目反向隧道和代理入口。
- HTTP/2 TLS（默认 `50051`）：ConnectRPC/gRPC API，路径前缀为 `/grpc`。

API 按身份隔离：Manager 管理用户和 Supervisor，User 管理自己的模板与项目，Supervisor 仅上报状态和拉取任务。请求使用 Ed25519 签名，载荷包含身份、时间戳和 nonce；Director 通过 Redis 防止 nonce 重放。开发模式支持专用的开发身份头。

Director 当前数据模型保持精简：`User`、`Supervisor`、`Template` 和 `Project`。项目支持 `Minimum`、`Standard`、`Performance` 三档资源规格，运行状态由调度器动态计算，不写入数据库。

### 调度与隧道

`ProjectService.Launch` 将项目写入 BullMQ。Supervisor 通过 client-streaming RPC 每 3 秒上报 CPU、内存、磁盘和运行数量，并可通过 `Fetch` 锁定一个任务。Director 为已分派项目创建临时 token 和反向隧道，维护 pending、pulling、running、terminated 状态及超时回队逻辑。

### MicroVM 隔离

Supervisor 为每个任务执行以下操作：

1. 分配 network namespace、veth 和 TAP，并配置 nftables/NAT。
2. 启动 Firecracker jailer，按资源档位设置 cgroup CPU/内存限制。
3. 挂载只读 `runtime.squashfs` 和独立 `scratch.ext4`。
4. VM 内用 OverlayFS 合并只读根和可写层。
5. 为该任务生成 WebDAV 密码，把宿主项目目录挂载到 `/workspace`。
6. 通过 `tini` 启动 `/app`，退出时同步工作区并关闭 VM。

当前资源档位分别约为 `1 vCPU / 1 GiB`、`2 vCPU / 2 GiB`、`4 vCPU / 4 GiB`（jailer 另预留 64 MiB）。

## 仓库结构

```text
.
├── services/
│   ├── director/          # 中央控制面与 SDK
│   ├── supervisor/        # Linux 宿主机执行节点
│   └── runner/            # Runner 占位实现
├── packages/
│   ├── rpc/               # 自研 Socket.IO RPC
│   ├── vm-agent/          # VM Agent / worktree 实验
│   ├── vm-manager/        # 早期 VM 管理实现
│   ├── vm-manager-panel/  # Next.js 面板原型
│   ├── vm-registry/       # 注册服务占位包
│   └── shared-config-typescript/
├── native/webdav/         # Go WebDAV 二进制及 TS 导出
├── pnpm-workspace.yaml
└── turbo.json
```

## 开发与运行

### 基础要求

- Node.js 22+
- pnpm 10.14+
- Go（构建 `native/webdav`）
- MySQL、Redis
- Director 的 TLS 私钥与证书
- Linux + KVM（运行 Supervisor/MicroVM）
- `sudo`、Firecracker/jailer、`iproute2`、`nftables`、`buildah`、`qemu-img`、`mkfs.ext4`、`mksquashfs` 等宿主工具

macOS/Windows 可以开发和构建大部分 TypeScript 模块，但不能运行 Firecracker 执行链路。

### 安装与检查

```bash
pnpm install
pnpm build
pnpm test

# 单独检查某个包
pnpm --filter @aw/vm-director typecheck
pnpm --filter @aw/rpc test
```

### 启动 Director

至少需要配置 MySQL、Redis、共享文件根和 HTTP/2 TLS 文件：

```dotenv
AW_DIRECTOR_MYSQL_URL=mysql://user:password@127.0.0.1:3306/agent_worker
AW_DIRECTOR_REDIS_URL=redis://127.0.0.1:6379/0
AW_DIRECTOR_FS_ROOT=/var/lib/agent-worker
AW_DIRECTOR_GRPC_CA_KEY=/path/to/server-key.pem
AW_DIRECTOR_GRPC_CA_CERTIFICATE=/path/to/server-cert.pem
AW_DIRECTOR_HTTP_PORT=3008
AW_DIRECTOR_GRPC_PORT=50051
```

```bash
pnpm --filter @aw/vm-director dev
```

首次部署还应固定配置 `AW_DIRECTOR_MANAGER_PUBLIC_KEY`；未配置时开发启动会生成并在日志中输出一组临时 Manager 密钥。

### 启动 Supervisor（仅限 Linux/KVM 开发机）

```dotenv
AW_SUPERVISOR_ID=<Director 创建的 Supervisor ID>
AW_SUPERVISOR_PRIVATE_KEY=<对应 Ed25519 私钥 hex>
AW_SUPERVISOR_DIRECTOR_HOST_URL=https://127.0.0.1:50051
AW_SUPERVISOR_FS_ROOT=/var/lib/agent-worker
```

```bash
pnpm --filter @aw/vm-supervisor dev
```

> 注意：当前 Supervisor 入口会直接创建两个随机项目的演示 VM，并定时访问其 `3000` 端口。请只在专用 Linux/KVM 开发环境运行；它还不是生产守护进程。

## 当前进度与下一步

已具备：

- ConnectRPC API、身份权限、签名与重放防护。
- MySQL 数据模型和用户/模板/项目/Supervisor 服务。
- Redis/BullMQ 排队、任务锁、超时回队和运行状态。
- Supervisor 指标上报、Firecracker/cgroup/网络/镜像编排。
- 按任务授权的 WebDAV 工作区与 VM 内挂载。
- HTTP/WebSocket 项目反向代理和隧道管理。

仍需完成：

- 将 Supervisor 的 `Fetch` 循环接入 `Orchestrator.create()`，移除两个演示 VM。
- 把项目资源档位、环境变量和任务元数据从 Director 完整传到 VM。
- 实现任务终止、重启、故障恢复和持久化运行记录。
- 明确并整合 `runner`、`vm-agent`、`vm-manager` 三条历史实现路径。
- 补充端到端测试、部署脚本、可观测性、安全审计和生产运维文档。
- 完成管理面板及对外使用示例。

## 参与开发

提交变更前请至少运行相关包的 `typecheck`、`test` 和根目录 `pnpm build`。基础设施代码会触及宿主网络、cgroup、文件目录和虚拟机生命周期；修改清理逻辑时，应同时验证成功、启动失败和进程异常退出三条路径。

如果你想参与，当前最清晰的切入点是 Supervisor 任务消费闭环、端到端测试、Runner 协议，以及重复 VM 实现的收敛。
