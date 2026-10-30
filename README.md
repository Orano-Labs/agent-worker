# Agent Worker

English | [简体中文](README_ZH.md)

Agent Worker is self-hosted execution infrastructure for coding agents. Its Director control plane manages users, projects, and templates, while Supervisor nodes create, constrain, and clean up Linux microVMs. Request signing, file APIs, reverse tunnels, and a web terminal provide the building blocks for integrating these environments into an agent product.

The goal is to give each user's code tasks an isolated environment with a workspace, bounded compute resources, and access to terminals and application services, with the host managing the environment's lifecycle. The runtime image currently includes `pi-coding-agent`; you can change the image build script and entrypoint to run a different program.

**Version `0.0.1` is undergoing an architectural refactor. Individual components can be developed independently, but a fresh checkout cannot yet run the complete Director → Supervisor → microVM workflow.** The sections below distinguish existing implementations from unfinished integrations and document the current setup requirements and blockers.

## Contents

- [Capabilities and limitations](#capabilities-and-limitations)
- [Architecture and repository layout](#architecture-and-repository-layout)
- [Development setup](#development-setup)
- [Configuring and using Director](#configuring-and-using-director)
- [Supervisor and runtime images](#supervisor-and-runtime-images)
- [Checks and tests](#checks-and-tests)
- [Contributing](#contributing)
- [License](#license)

## Capabilities and limitations

“Implemented” here means the corresponding logic exists in the source. It does not mean the complete service has been verified end to end.

| Area | Implemented | Current limitation |
| --- | --- | --- |
| Control plane | RPCs for users, Supervisors, templates, projects, and files; MySQL/Drizzle data layer and migrations | The Director build entrypoint and some legacy modules still need to be migrated |
| Authentication | Manager, User, and Supervisor identities; Ed25519 signatures, timestamp validation, and Redis-backed nonce replay protection | Non-production mode accepts a development identity header and must be restricted to trusted development environments |
| Project and template files | RPCs for creating, reading, writing, listing, deleting, moving, and copying files | ZIP downloads do not finalize the archive; chunked uploads have protocol and SDK definitions only |
| Scheduling | Capacity and deployment data models, a legacy allocator, and the `Watch / Acknowledge / Release` protocol | The new `Scheduler` is a placeholder; the Portal has no server-side handler, and Supervisor does not consume assignments |
| MicroVMs | Firecracker/jailer, network namespaces, TAP/veth, nftables, CPU/memory cgroups, and a read-only root with a writable OverlayFS layer | The Supervisor entrypoint creates one `minimal` demo VM with a random ID |
| Workspaces | Supervisor filesystem support, dynamic NFS-Ganesha exports, and a standalone Go WebDAV service | Workspace exports are not connected to the demo VM; host project files are not automatically available at `/workspace` |
| Remote access | Director tunnel components, the SDK's `TunnelClient`, and a separate `@aw/tunnel` library | The Director entrypoint does not instantiate the tunnel service; `/link` forwarding handlers are empty |
| Web terminal | Go-based `ptyd` with a PTY, HTTP UI, WebSocket transport, terminal state restoration, and idle shutdown | The VM entrypoint currently runs `pi` on port `8000`; model configuration must be supplied separately |

There is no ready-to-use management UI or complete agent task API. `ProjectService` has no `Launch` RPC, and creating a project does not start a VM. The former BullMQ/Fetch workflow, separate HTTP/2 TLS port, and directories such as `runner`, `vm-agent`, and `vm-manager` no longer describe the current repository.

## Architecture and repository layout

Solid arrows show current component dependencies or local execution paths. Dashed arrows show integrations that remain to be completed.

```mermaid
flowchart LR
  Client["Application / TypeScript SDK"] --> API["Director<br/>HTTP + Connect /grpc"]
  API --> DB[("MySQL / Drizzle<br/>Users, nodes, templates, projects, deployments")]
  API --> Redis[("Redis<br/>Cache and signature nonces")]
  API --> Files["Director project / template directories"]
  API -. "Scheduling, assignments, and tunnels: pending" .-> Supervisor["Supervisor / VMFactory"]
  Supervisor --> Host["Linux KVM<br/>jailer, cgroups, isolated networking"]
  Host --> VM["MicroVM<br/>SquashFS + ext4 / OverlayFS"]
  VM --> Terminal["ptyd :8000 → pi"]
  Workspace["NFS-Ganesha / WebDAV components"] -. "Workspace mounts: pending" .-> VM
```

```text
.
├── services/
│   ├── director/
│   │   ├── src/api/            # RPC and tunnel handlers
│   │   ├── src/internal/       # Data, authentication, files, and tunnels
│   │   ├── src/sdk/            # Signed client and TunnelClient
│   │   ├── proto/              # Public API definitions
│   │   └── drizzle/migrations/ # MySQL migrations
│   └── supervisor/
│       ├── src/internal/       # VMs, images, networking, NFS, and files
│       ├── proto/              # Node filesystem and deployment protocols
│       ├── resources/          # VM init, entrypoint, and app test resources
│       └── scripts/            # Image builds, Firecracker downloads, codegen
├── native/
│   ├── ptyd/                   # Go web terminal and Linux binary exports
│   └── webdav/                 # Go WebDAV service with a Unix socket API
├── packages/
│   ├── container/              # Dependency injection and service lifecycle
│   ├── environment/            # Prefixed environment variables and dotenv
│   ├── logging/                # Pino logging wrapper
│   ├── proto/                  # Protobuf types, service abstractions, registry
│   ├── proto-codegen/          # Custom Protobuf TypeScript generator
│   ├── tunnel/                 # Socket pairs, HTTP/2 tunnels, stream bridging
│   └── shared-config-typescript/
├── docker/                     # Director / Supervisor Dockerfiles; need updates
├── docs/SDK_USAGE_GUIDE.md      # Detailed SDK examples in Chinese; partly outdated
├── pnpm-workspace.yaml
└── package.json
```

The main stack is TypeScript, Node.js, pnpm workspaces, ConnectRPC, Protobuf/Buf, Drizzle/MySQL, and Redis, alongside Go, Firecracker, and Linux networking tools. The root build script uses recursive pnpm commands; Turbo configuration is also present.

## Development setup

### Requirements

| Scope | Requirements |
| --- | --- |
| TypeScript components, SDK, and control plane | Node.js 24 recommended; the root `packageManager` field specifies `pnpm@11.18.0` |
| Go components and full repository builds | Go 1.27 or a compatible toolchain recommended; `ptyd/go.mod` specifies `1.27.0`, and `webdav/go.mod` specifies `1.26.1` |
| Director runtime and database integration tests | MySQL, Redis, and a writable file directory; the test helpers currently request MySQL `9.7.2` and Redis `8.10.2` |
| Supervisor / microVM execution | Linux x86_64 or aarch64, a working `/dev/kvm`, cgroups, and root or equivalent host privileges |
| Runtime image builds | Linux, Bash, Buildah, `mksquashfs`, Node.js/npm, pnpm, and network access to download images and packages |

The repository does not declare a common minimum Node.js version through `engines`; Node.js 24 matches the major version used by the Dockerfiles. Some packages still specify `pnpm@10.14.0`; use the root version for development. You can develop TypeScript and some Go components on macOS. The full Firecracker workflow requires Linux/KVM; use a Linux environment when developing on Windows.

### Install dependencies and build shared components

After cloning the repository or your fork, run these commands from the repository root:

```bash
pnpm install --frozen-lockfile

# Build the shared components used by services and code generators.
# These do not require a VM.
pnpm --filter @aw/container --filter @aw/environment --filter @aw/logging \
  --filter @aw/proto --filter @aw/proto-codegen --filter @aw/tunnel -r build

# Start with tests that do not require a database or VM.
pnpm --filter @aw/container test --run
```

Outside CI, installation runs `lefthook install` to set up the pre-commit hook. Initial dependency installation, Buf dependencies, and native toolchain setup may require network access.

### Generate protocol types and the Firecracker client

Generated service files are excluded by each service's `.gitignore` and must be generated after a fresh checkout. Build the shared components above first so that the local `proto-codegen` plugin is available, then run:

```bash
# Director extension types and API types.
pnpm --filter @aw/vm-director exec buf generate --template buf.gen.extensions.yaml
pnpm --filter @aw/vm-director gen:proto

# Supervisor protocol types and Firecracker OpenAPI client.
pnpm --filter @aw/vm-supervisor gen:proto
pnpm --filter @aw/vm-supervisor generate:firecracker-api
```

`gen:proto` includes a separate registry generation script. The Firecracker OpenAPI generator queries GitHub for the latest release, so its output is not pinned to a particular Firecracker version. Check that the generated client matches the binaries you use.

These commands generate code; **they do not resolve every outstanding refactor issue**. Director still references old `Repository`, logging, and key modules, and its build configuration points to a missing `src/index.ts` instead of the actual startup entrypoint, `src/main.ts`. The old command `pnpm --filter @aw/vm-director generate` is no longer valid: that package has no `generate` script.

## Configuring and using Director

### Configuration

Director currently uses a single HTTP port, `3008` by default, with Connect API routes under `/grpc`. The adapter enables Connect only: **native gRPC and gRPC-Web are disabled, and there is no built-in TLS listener**. Configure HTTPS at an ingress or reverse proxy for remote deployments.

`Environment` loads `.env` from its root directory, determines the mode from `NODE_ENV`, then loads `.env.<mode>`. Existing process environment variables take priority; otherwise the mode-specific file overrides the base file. Director uses the process working directory as its root. When running `pnpm --filter @aw/vm-director dev`, place its configuration in `services/director/.env`.

```dotenv
# services/director/.env — replace these example values.
NODE_ENV=production
AW_DIRECTOR_DATABASE_URL=mysql://aw:replace-me@127.0.0.1:3306/agent_worker
AW_DIRECTOR_DATABASE_MIGRATIONS=./drizzle/migrations
AW_DIRECTOR_REDIS_URL=redis://127.0.0.1:6379/0
AW_DIRECTOR_FS_ROOT=/tmp/agent-worker-director-files
AW_DIRECTOR_HTTP_PORT=3008
# Required for a manager client using real signatures:
# AW_DIRECTOR_MANAGER_PUBLIC_KEY=<hex-encoded Ed25519 SPKI DER public key>
```

| Variable | Purpose |
| --- | --- |
| `AW_DIRECTOR_DATABASE_URL` | Required MySQL connection string; replaces the old `AW_DIRECTOR_MYSQL_URL` |
| `AW_DIRECTOR_DATABASE_MIGRATIONS` | Required migrations directory; relative paths resolve from the process working directory |
| `AW_DIRECTOR_REDIS_URL` | Required Redis connection string |
| `AW_DIRECTOR_FS_ROOT` | Root directory for project and template files; required for file operations |
| `AW_DIRECTOR_HTTP_PORT` | Optional; defaults to `3008` |
| `AW_DIRECTOR_MANAGER_PUBLIC_KEY` | Hex-encoded public key for verifying manager signatures; the server does not need the manager's private key |
| `NODE_ENV` | Defaults to `development`; only `production` disables the development identity header |

Create the MySQL database named in your connection string, start Redis, and grant write access to the file root. Database initialization applies migrations automatically; no separate Prisma command is needed. To change the schema, run `pnpm --filter @aw/vm-director gen:db` to generate a Drizzle migration and review the SQL.

Once the build and protocol integration blockers are resolved, start the development server with:

```bash
pnpm --filter @aw/vm-director dev
```

The built service starts with `pnpm --filter @aw/vm-director start`, which expects `dist/index.cjs`. The build entrypoint must be fixed before this path is usable.

### Using the SDK

The SDK lives in the Director package and exposes `@aw/vm-director/sdk` and `@aw/vm-director/tunnel`. Build and test it inside the workspace first; a package definition in this repository does not establish that a usable version has been published to npm.

The following example shows the structure of a signed client. It requires a repaired and built Director package, a running server, and a registered user:

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

The example's `DIRECTOR_USER_*` variables belong to the calling application, not the Director server configuration. Identity private keys use hex-encoded PKCS#8 DER; the manager public key uses hex-encoded SPKI DER. The SDK generates a signature, nonce, and timestamp for each request. A manager creates users through `UserService`, and users manage their own projects. Store private keys securely when an identity is created; do not send them to a browser.

For more examples, see the [Director SDK usage guide](docs/SDK_USAGE_GUIDE.md), currently available in Chinese. **The guide has not yet been updated for this refactor.** Its descriptions of gRPC-Web, Portal/watch, `/link`, some file RPCs, and the `generate` command are outdated; refer to the current source and the limitations documented here. An SDK method does not imply that the server implements it. The public signer property for ordinary HTTP requests is currently spelled `client.singer`.

### Outstanding control-plane integrations

- `Scheduler` is an empty class. The legacy `Allocator` depends on removed modules and has not been migrated to the Drizzle data layer.
- `SupervisorPortalService` has proto definitions and an SDK client, but no server-side implementation.
- `SupervisorTunnelService` is registered as a container provider but is not instantiated by the entrypoint's dependency graph. The container removes unused providers. Even if the service is connected, its `/link` HTTP and upgrade handlers are still empty.
- File `move/copy` handlers exist. `FileUploadService` is not registered, and ZIP `download` does not call `finalize()`, so downloads cannot be relied on to finish.

## Supervisor and runtime images

Supervisor currently exercises local VM startup. Its entrypoint depends on `VMFactory` and does not connect to Director, report metrics, or process project assignments. NFS-Ganesha, the HTTP/RPC server, and LMDB have implementations and provider definitions, but the entrypoint's dependency graph does not activate them.

### Prepare the host and build artifacts

Use a dedicated Linux/KVM development host. VM network initialization changes host IP forwarding and nftables rules and removes stale network namespaces managed by this module. The jailer needs device, cgroup, and directory permissions. Required tools include `ip`, `nft`, `sysctl`, `truncate`, and `mkfs.ext4`, plus `firecracker`, `jailer`, and `vmlinux` for the host architecture.

After installing dependencies and generating protocol and OpenAPI code, prepare the artifacts below. Run these commands from the repository root:

```bash
# Download Firecracker, jailer, and a CI kernel for the host architecture.
# Requires curl, wget, tar, and GNU grep with -P support.
bash services/supervisor/scripts/download-firecracker-ci.sh /tmp/aw-firecracker-artifacts

# Build the Linux amd64 and arm64 ptyd binaries.
pnpm --filter @aw/ptyd build

# Supply the binary path explicitly to avoid package-resolution differences
# in the image script. Use ptyd-linux-arm64 on an aarch64 host.
PTYD_SOURCE="$PWD/native/ptyd/dist/ptyd-linux-amd64" \
  bash services/supervisor/scripts/build-runtime-image.sh /tmp/aw-runtime.squashfs
```

The image script uses rootless Buildah, which requires subordinate UID/GID ranges and a compatible storage driver. It downloads Alpine packages and installs `@earendil-works/pi-coding-agent`; not all upstream versions are pinned. Supervisor only checks for an existing `runtime.squashfs` at startup. It does not build the image automatically.

### Configuration and demo entrypoint

The Supervisor entrypoint fixes its environment root at `/aw-supervisor`. It reads `.env` there and creates runtime directories, including the jailer directory, under that root. The current VM path uses these settings:

```dotenv
# /aw-supervisor/.env
AW_SUPERVISOR_FIRECRACKER_ARTIFACTS=/tmp/aw-firecracker-artifacts
AW_SUPERVISOR_RUNTIME_IMAGE=/tmp/aw-runtime.squashfs
```

Without an explicit runtime image path, Supervisor looks for `/aw-supervisor/images/runtime.squashfs`. `AW_SUPERVISOR_FS_ROOT` configures the filesystem component. `AW_SUPERVISOR_SERVER_HOST` and `AW_SUPERVISOR_SERVER_PORT` configure the HTTP server, which defaults to port `3000` and is not connected to the entrypoint; these settings do not control the application inside the VM. Identity credentials belong in a local env file; there is currently no Director connection logic in the Supervisor entrypoint that consumes them.

Once host permissions and artifacts are in place, run the demo entrypoint with:

```bash
pnpm --filter @aw/vm-supervisor dev
```

Current VM resource tiers are:

| `machineTier` | vCPUs | Guest memory |
| --- | --- | --- |
| `minimal` | 1 | 256 MiB |
| `standard` | 2 | 512 MiB |
| `performance` | 4 | 1024 MiB |

The jailer's memory cgroup adds a `64 MiB` budget for VMM overhead. Each VM gets a writable scratch disk of `512 MiB` by default. These are the current `VMFactory` values; they are not yet automatically mapped from Director's resource enum.

Inside the VM, SquashFS and ext4 provide the read-only and writable layers for OverlayFS. The init script reduces capabilities and includes optional NFS mount support. The application entrypoint runs `ptyd --port 8000 --idle-timeout 10s --command /usr/local/bin/pi --dir /workspace -- --continue`. The demo does not inject a project workspace, model credentials, or NFS configuration; those integrations are still required to run real agent tasks.

### Docker status

The [Director Dockerfile](docker/Dockerfile.director) and [Supervisor Dockerfile](docker/Dockerfile.supervisor) illustrate the intended deployment structure, but are not ready-to-use deployment recipes. Both call the removed Director `generate` script. Database credentials must be injected at runtime, and the Supervisor image's resource copy paths need to be reconciled with the image build script. The repository does not include Docker Compose or a complete deployment configuration.

## Checks and tests

TypeScript packages use Vitest. Run Go tests separately. Most `test` scripts enter watch mode by default; add `--run` for a single run:

```bash
# Choose checks for the packages you changed. Build shared dependencies
# and generate code before checking services.
pnpm --filter @aw/container typecheck
pnpm --filter @aw/container test --run
pnpm --filter @aw/tunnel test --run
pnpm --filter @aw/vm-director typecheck
pnpm --filter @aw/vm-supervisor typecheck

# All TypeScript tests and builds; known failures are listed below.
pnpm test --run
pnpm build

# The root pnpm test command does not run Go tests.
go -C native/ptyd test ./...
go -C native/webdav test ./...

# Check changed source files without rewriting the whole repository.
pnpm exec biome check path/to/changed-file.ts
```

Director database tests start real processes through `mysql-memory-server` and `redis-memory-server`; the first run may download binaries. Tunnel tests need permission to listen on local TCP and Unix sockets. VM startup, failure cleanup, and shutdown require a host with working networking and KVM. The root `pnpm lint` and `pnpm format` commands use `--write` and modify files.

Limited verification performed when this README was rewritten on October 30, 2026:

- All six shared components built successfully, and all 27 `@aw/container` tests passed.
- With local socket listening permitted, `@aw/tunnel` had 83 passing tests and one failure: an extended CONNECT test expected `:protocol` to be `tcp`, but received `http`.
- The Director build failed because `src/index.ts` is missing. Type checking also reported legacy module references and other errors.
- Supervisor type checking was blocked by the protocol registry and Firecracker OpenAPI files that had not yet been generated. Execution on Linux/KVM was not verified.

These checks do not establish that the full repository passes. There is currently no CI workflow; describe your verification scope and any existing failures in each pull request.

## Contributing

Bug reports, reproducible examples, documentation improvements, and code contributions are welcome. Start with the relevant service's `src/application.ts` to understand which dependencies are actually instantiated, then follow the API/proto definitions, internal services, and tests.

### Areas where help is needed

1. **Make fresh checkouts build reliably.** Align entrypoints, generation steps, legacy modules, and package versions; update the Dockerfiles and SDK guide.
2. **Complete deployment scheduling.** Migrate the legacy allocation logic, implement the Portal, and connect Supervisor to the VM lifecycle, including disconnect and restart recovery.
3. **Connect workspaces and runtime configuration.** Clarify the roles of NFS and WebDAV and pass project directories, resource tiers, and agent configuration into VMs.
4. **Finish access and file APIs.** Connect tunnels and project routing, complete chunked uploads and ZIP downloads, and verify authorization and path boundaries.
5. **Improve reliability checks.** Resolve existing test failures, add CI and Linux/KVM integration tests, and cover initialization failures, cancellation, and resource cleanup.

These are gaps in the current implementation, not a committed release roadmap. For substantial protocol or architectural changes, open an issue first to explain the problem, proposed approach, and compatibility impact.

### Issues and pull requests

- For bug reports, include reproduction steps, expected and actual behavior, the relevant commit, OS and architecture, toolchain versions, and sanitized logs. For VM issues, include KVM, cgroup, and Firecracker details.
- Fork the repository and work on a separate branch. Keep each pull request focused on one problem, and explain what changed, why, and how you verified it.
- Add tests for behavior changes. For API changes, update the `.proto` definitions, server handlers, SDK, and documentation together. Generated directories are ignored; change the protocol or generator and document how to regenerate the output.
- Include a reviewed Drizzle migration when changing the database schema. Updating only your local database is not sufficient.
- Run the affected packages' builds, type checks, and tests before submitting. If an existing blocker prevents a check from passing, include the command and failure reason. Do not mark checks as passed unless you ran them.
- The pre-commit hook runs Biome on staged files and stages automatic fixes. Review the final diff before committing.

### Credentials and security reports

Keep real credentials in local environment files. Copy [services/director/.env.example](services/director/.env.example) to `services/director/.env` for the server, and [.env.manager.example](services/director/.env.manager.example) to `services/director/.env.manager` for the trusted provisioning client. The Director server needs only the manager's public key; never pass the manager env file to the server or an image build. Supervisor loads its configuration from `/aw-supervisor/.env`; use [its example](services/supervisor/.env.example) as a starting point. Restrict real env files to their owner (`chmod 600`).

Git ignores `.env` and `.env.*`, with exceptions for `.env.example` and `.env.*.example` templates. Docker excludes all env variants, private-key files, and Git metadata from the build context. These rules do not protect secrets already tracked in Git. Do not commit private keys, model API keys, database passwords, real user workspaces, or unsanitized logs. Inject production settings at runtime, for example with Docker's `--env-file`; set `NODE_ENV=production` to disable unsigned development identities.

The Supervisor provisioning script reads `.env.manager`, uses Connect with real signatures, and requires HTTPS for remote endpoints. It writes the returned identity credentials to a new local env file with owner-only permissions, rather than logging private keys. It refuses to overwrite an existing output file. The current demo Supervisor does not yet consume those identity settings.

Run `pnpm security:scan` for the working tree and `pnpm security:scan:history` for reachable Git history. These checks report locations without secret values and cover known credential formats; a passing scan is not a complete security audit. **Historical identity private keys and a TLS private key were found during the pre-release review. Moving current values to env files does not revoke them or remove earlier commits.** Before publishing, rotate affected credentials, replace the TLS certificate/key, and remove the sensitive history from every ref being published, or publish a separately reviewed clean snapshot. The production dependency audit also has unresolved findings. See the [review record](docs/SECURITY_REVIEW.md) for scope and remaining work.

Report authentication bypasses, host escapes, path traversal, and credential exposure privately. Use the hosting platform's private vulnerability reporting channel if enabled; otherwise contact a maintainer to establish a private channel first. Never include usable credentials or exploit details in a public issue. See [SECURITY.md](SECURITY.md) for reporting guidance.

## License

This project is licensed under the [Apache License 2.0](LICENSE). Third-party components used or downloaded by the runtime have their own licenses. Preserve any required license and attribution notices when distributing images or binaries. Contributions under the project's license are welcome.
