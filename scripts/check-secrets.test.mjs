import assert from "node:assert/strict";
import test from "node:test";
import { scanText } from "./check-secrets.mjs";

test("detects private keys and reports only locations", () => {
  const privateKey = `302e020100300506032b657004220420${"a".repeat(64)}`;
  const findings = scanText("script.ts", `// comment\nconst key = "${privateKey}";`);
  assert.deepEqual(findings, [{ path: "script.ts", line: 2, rule: "Ed25519 PKCS8 private key" }]);
  assert.ok(!JSON.stringify(findings).includes(privateKey));
  assert.equal(scanText("tls.pem", ["-----BEGIN", "PRIVATE KEY-----"].join(" ")).length, 1);
});

test("detects provider tokens and embedded URL passwords", () => {
  assert.equal(scanText("script.ts", `ghp_${"a".repeat(36)}`)[0].rule, "provider token");
  assert.equal(scanText("Dockerfile", "mysql://user:" + "actual-password@db/app")[0].rule, "credential URL");
});

test("allows placeholders without allowing secrets elsewhere in example files", () => {
  assert.deepEqual(scanText(".env.example", "DATABASE_URL=mysql://aw:replace-me@localhost/db"), []);
  const tokenPlaceholder = ["$", "{NPM_TOKEN}"].join("");
  assert.deepEqual(scanText(".npmrc", `//registry.npmjs.org/:_authToken=${tokenPlaceholder}`), []);
  assert.equal(scanText(".env.example", `ghp_${"a".repeat(36)}`).length, 1);
});

test("flags tracked env variants and credential files, including empty files", () => {
  for (const path of [".env", "services/director/.env.production", ".env.manager", "credentials.json", "cert.p12", ".netrc"]) {
    assert.equal(scanText(path, "").length, 1);
  }
  assert.deepEqual(scanText("services/director/.env.manager.example", ""), []);
});
