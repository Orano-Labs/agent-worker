const fs = require("node:fs");
const cp = require("node:child_process");
const http = require("node:http");

console.log("");
console.log("==================================================");
console.log("   Hello from Node.js inside Firecracker MicroVM! ");
console.log(`   Node.js version: ${process.version}            `);
console.log(`   Now: ${Date.now()}                             `);
console.log("==================================================");
console.log("");

// === 如何在应用启动时加载并注入到 process.env ===
async function bootstrap() {
  const mmdsIp = "169.254.169.254";

  try {
    // 1. 请求 Token (有效期设为 60 秒)
    const tokenResponse = await fetch(`http://${mmdsIp}/latest/api/token`, {
      method: "PUT",
      headers: {
        "X-metadata-token-ttl-seconds": "60",
      },
    });

    if (!tokenResponse.ok) {
      throw new Error(`无法获取 MMDS Token: ${tokenResponse.statusText}`);
    }

    const token = await tokenResponse.text();

    console.log("MMDS Token:", token);

    // 2. 使用 Token 请求元数据 (获取你在宿主机注入的整个 JSON 对象)
    const dataResponse = await fetch(`http://${mmdsIp}/latest/meta-data`, {
      method: "GET",
      headers: {
        "X-metadata-token": token,
        Accept: "application/json",
      },
    });

    if (!dataResponse.ok) {
      throw new Error(`无法获取 MMDS 元数据: ${dataResponse.statusText}`);
    }

    await dataResponse.text().then((result) => {
      console.log(result);
    });
  } catch (error) {
    console.error("获取 MMDS 环境变量失败:", error);
    return null;
  }

  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.write(req.rawHeaders.join("\n"));
    res.end("OK");
  });

  server.listen(3000, () => {
    console.log("HTTP Server running at :3000");
  });
}

bootstrap();
