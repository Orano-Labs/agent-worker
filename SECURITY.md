# Security policy

Agent Worker is pre-release infrastructure. See the README for current implementation and verification limits; no stable release or supported security-update window is declared yet.

## Reporting a vulnerability

Use the repository host's private vulnerability reporting feature if it is enabled. Otherwise contact a maintainer through an available private channel and agree on a reporting channel before sharing details. This repository does not advertise a dedicated security email address or promise a response time.

Do not open public issues containing private keys, API tokens, database URLs with passwords, customer workspaces, or exploit details for an unpatched vulnerability. Include the affected revision, prerequisites, impact, and a minimal reproduction with synthetic data. Redact logs and configuration values.

## Credentials

Copy the service `.env.example` templates for local configuration. Keep manager private keys in `services/director/.env.manager`, separate from server configuration; the Director server only needs the public key. Inject secrets at runtime and restrict env files to owner access. Never include real env files in source archives, container build contexts, or npm packages.

Before exposing Director remotely, set `NODE_ENV=production` and terminate HTTPS at a trusted ingress. Development identities do not verify signatures. The provisioning client permits plain HTTP only on loopback.

Run `pnpm security:scan` before sharing a working-tree snapshot and `pnpm security:scan:history` before publishing Git refs. The lightweight scanner detects selected credential formats and real env filenames; it does not replace manual review or a comprehensive scanner. Ignoring or deleting a file does not erase earlier commits or revoke a credential.

The [pre-release review](docs/SECURITY_REVIEW.md) records historical private-key exposure and outstanding release actions. Rotate affected identity keys and TLS material before release. History cleanup must cover all published refs and any copies already distributed; rotation remains necessary even after cleanup.
