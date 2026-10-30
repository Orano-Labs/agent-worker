import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

// Deliberately report locations and rule names only, never matching values.
const rules = [
  ["PEM private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ["Ed25519 PKCS8 private key", /302e020100300506032b657004220420[0-9a-f]{64}/gi],
  [
    "provider token",
    /(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}/g,
  ],
  ["credential URL", /(?:mysql|postgres(?:ql)?|rediss?|https?):\/\/[^\s/"'`:@]+:([^\s/"'`@]+)@/gi],
  ["registry auth token", /(?:_authToken|_auth)\s*=\s*([^\s"'`]+)/g],
];

function isPlaceholder(value) {
  return /^(?:replace-me|change-me|your[-_].*|<[^>]+>|\$\{[^}]+\})$/i.test(value);
}

export function scanText(path, text) {
  const findings = [];
  const name = basename(path);
  if ((name === ".env" || name.startsWith(".env.")) && !name.endsWith(".example")) {
    findings.push({ path, line: 1, rule: "real env file" });
  }
  if (/\.(?:p12|pfx)$/i.test(name) || name === ".netrc" || name === "credentials.json") {
    findings.push({ path, line: 1, rule: "credential file" });
  }

  for (const [rule, pattern] of rules) {
    for (const match of text.matchAll(pattern)) {
      if ((rule === "credential URL" || rule === "registry auth token") && isPlaceholder(match[1])) continue;
      const line = text.slice(0, match.index).split("\n").length;
      findings.push({ path, line, rule });
    }
  }
  return findings;
}

function git(args, options = {}) {
  return execFileSync("git", args, { maxBuffer: 256 * 1024 * 1024, ...options });
}

function scanWorktree() {
  // Include tracked files even if newly ignored, plus non-ignored new files.
  const paths = new Set(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).toString().split("\0").filter(Boolean));
  const findings = [];
  for (const path of paths) {
    try {
      if (!lstatSync(path).isFile()) continue;
      findings.push(...scanText(path, readFileSync(path, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return findings;
}

function scanHistory() {
  const objects = git(["rev-list", "--objects", "--all"]).toString().trim().split("\n");
  const paths = new Map(
    objects.filter((line) => line.includes(" ")).map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)]),
  );
  const input = `${[...paths.keys()].join("\n")}\n`;
  const metadata = git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input }).toString().trim().split("\n");
  const blobs = metadata.filter((line) => line.endsWith(" blob")).map((line) => line.split(" ")[0]);
  if (!blobs.length) return [];
  const data = git(["cat-file", "--batch"], { input: `${blobs.join("\n")}\n` });
  const findings = [];
  let offset = 0;
  for (const sha of blobs) {
    const end = data.indexOf(10, offset);
    const size = Number(data.subarray(offset, end).toString().split(" ")[2]);
    offset = end + 1;
    const text = data.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
    findings.push(...scanText(paths.get(sha), text).map((finding) => ({ ...finding, blob: sha.slice(0, 12) })));
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.chdir(git(["rev-parse", "--show-toplevel"]).toString().trim());
    const history = process.argv.includes("--history");
    const findings = history ? scanHistory() : scanWorktree();
    for (const finding of findings) {
      console.error(`${JSON.stringify(finding.path)}:${finding.line}: ${finding.rule}${finding.blob ? ` (blob ${finding.blob})` : ""}`);
    }
    console.log(`${history ? "History" : "Worktree"} secret scan: ${findings.length} finding(s). Values are never printed.`);
    process.exitCode = findings.length ? 1 : 0;
  } catch {
    console.error("Secret scan could not complete. Run it inside a readable Git checkout.");
    process.exitCode = 2;
  }
}
