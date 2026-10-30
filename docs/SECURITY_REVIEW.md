# Pre-release security review — 2026-10-30

## Scope

Reviewed tracked source, configuration, scripts, examples, Docker build inputs, and reachable local Git history for embedded credentials. The initial history pass examined 365 reachable commits and 1,157 blobs under 2 MB. The repeatable history scanner also checks larger reachable blobs. This review does not establish that a running deployment, all dependencies, host isolation, or every authentication path is secure. No live Director deployment was contacted and no identity was provisioned.

## Changes in the working tree

- Migrated the hardcoded manager private key and remote endpoint from `services/director/scripts/generate-test-supervisor.ts` into ignored `services/director/.env.manager`. Migrated Docker connection values into ignored `services/director/.env`, using the current `AW_DIRECTOR_DATABASE_URL` name. Both local files were created with mode `0600`. These migrated values are preserved for local configuration, not certified safe for continued use.
- Added separate server, manager-client, and Supervisor env templates. Removed embedded connection settings and unused identity placeholders from Dockerfiles. The Director image no longer requests a manager private key.
- Changed provisioning to Connect with real signatures, HTTPS for remote endpoints, exclusive env-file creation, and no private-key logging. The output defaults to `services/supervisor/.env`. Existing files are not overwritten. A write failure after remote identity creation may require an operator to revoke/recreate that identity; error output deliberately omits RPC payloads.
- Expanded Git ignores for env variants and credential files. Docker additionally excludes env files at every depth and Git metadata. Removed a personal absolute path from `reasonix.toml`.
- Made injected environment values take priority over dotenv files, preventing a checked-in or mounted file from downgrading injected production mode. `files: false` now still honors `NODE_ENV`; environment validation errors no longer echo raw values.
- Added `pnpm security:scan`, `pnpm security:scan:history`, and scanner regression tests. Findings contain only paths, line numbers, rule names, and historical blob identifiers.

## Release blockers: historical credentials

The initial history pass found private-key material in older blobs of these paths. No secret values are reproduced here.

| Path in history | Finding |
| --- | --- |
| `services/director/scripts/generate-test-supervisor.ts` | Manager Ed25519 private key |
| `services/director/src/index.ts` | Ed25519 private key |
| `services/supervisor/src/index.ts` | Ed25519 private key |
| `services/supervisor/src/main.ts` | Ed25519 private key |
| `services/supervisor/src/internal/controller.ts` | Ed25519 private key |
| `services/supervisor/src/internal/tunnel.ts` | Ed25519 private key |
| `services/director/localhost+2-key.pem` | TLS private key |

Old README connection examples also match the credential-URL rule; example placeholders must be distinguished from deployed passwords. The local scan cannot establish whether any historical credential is still active, whether a certificate was trusted beyond localhost, or which material has already reached a remote or third party.

Before publication, the operator must:

1. Rotate affected identity key pairs and update their verifying public keys in Director configuration or stored identities. Replace any affected TLS certificate/key and any reused database passwords.
2. Remove sensitive history from every branch and tag to be published, or publish a separately reviewed clean source snapshot. The existing history has not been rewritten by this review; `security:scan:history` is expected to fail until it is cleaned.
3. Review remote copies, forks, release archives, container layers, caches, and logs that may contain the old material. Excluding `.git` from future image builds does not clean existing images.
4. Rerun both scans on the exact release candidate and perform deployment-specific authentication and VM isolation review.

History rewriting and remote changes require a coordinated release decision and were not performed here. Live credentials were not rotated because this checkout does not establish the owners or active deployment configuration.

## Dependency audit: unresolved findings

The read-only production audit against the official npm registry reported **46 advisory entries: 1 critical, 17 high, 21 moderate, and 7 low**, across 12 packages in the resolved dependency graph. This is an audit result for the lockfile, not a determination that all advisories are exploitable in this deployment. No dependency versions were changed in this credentials-focused pass.

```bash
pnpm audit --prod --registry=https://registry.npmjs.org
```

| Package | Resolved version | Advisory entries | Minimum satisfying all reported patched ranges | Example source |
| --- | --- | --- | --- | --- |
| `tar` | 7.5.16 | 1 critical, 2 high, 2 moderate | >=7.5.21 | [Advisory](https://github.com/advisories/GHSA-23hp-3jrh-7fpw) |
| `brace-expansion` | 5.0.9 | 2 high, 1 moderate | >=5.0.12 | [Advisory](https://github.com/advisories/GHSA-qhr7-859c-m2p7) |
| `find-my-way` | 9.6.0 | 1 high | >=9.7.0 | [Advisory](https://github.com/advisories/GHSA-c96f-x56v-gq3h) |
| `nanoid` | 5.1.11 | 1 high | >=5.1.16 | [Advisory](https://github.com/advisories/GHSA-28wg-ghj8-5hjv) |
| `undici` | 7.25.0 | 10 high, 14 moderate, 5 low | >=7.30.1 | [Advisory](https://github.com/advisories/GHSA-vmh5-mc38-953g) |
| `zod` | 4.4.3 | 1 high | >=4.6.6 | [Advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) |
| `fast-copy` | 4.0.3 | 1 moderate | >=4.1.0 | [Advisory](https://github.com/advisories/GHSA-jggr-w7fw-pc2j) |
| `parseuri` | 0.0.6 | 1 moderate | >=3.0.1 | [Advisory](https://github.com/advisories/GHSA-6fx8-h7jm-663j) |
| `uuid` | 3.4.0 | 1 moderate | >=11.1.1 | [Advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq) |
| `valibot` | 1.2.0 | 1 moderate | >=1.4.2 | [Advisory](https://github.com/advisories/GHSA-5qjj-4xww-7phc) |
| `cookie` | 0.4.2 | 1 low | >=0.7.0 | [Advisory](https://github.com/advisories/GHSA-pxg6-pf52-xh8x) |
| `debug` | 4.1.1 | 1 low | >=4.3.1 | [Advisory](https://github.com/advisories/GHSA-gxpj-cx7g-858c) |

Prioritize direct dependencies `tar`, `undici`, `find-my-way`, `nanoid`, and `zod`, then review transitive paths through `orpc`, `archiver`, `drizzle-orm`, and `pino-pretty`. Some transitive fixes require major upgrades or replacement of a parent dependency; do not apply unrestricted overrides without compatibility tests. Remediate these findings before declaring the release dependency-safe and rerun the audit on the final lockfile.

## Verification

Executed checks:

- Environment loading: 4 Vitest tests passed; package type check and build passed.
- Secret scanner: 4 Node tests passed; the final working-tree scan reported 0 findings.
- Reachable history scan: 8 findings remain (7 private-key locations and 1 historical credential URL); failure is expected until release-history cleanup.
- Biome check on the changed TypeScript/JavaScript and package metadata passed.
- Git ignore checks confirmed real env variants and key files are excluded while example templates remain eligible for tracking; both migrated env files have mode `0600`.
- Director type checking remains blocked by 24 existing diagnostics involving legacy/generated modules and other integration issues. No provisioning request or Linux/KVM runtime test was performed.

The scanner intentionally covers selected known formats; it does not detect every encoded secret, arbitrary password literal, or sensitive user dataset. Public env templates use placeholders and blank key fields. Existing build/protocol integration blockers documented in the README still apply.
