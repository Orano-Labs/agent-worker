const fs = require("node:fs");
const cp = require("node:child_process");

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

  console.log("CWD", process.cwd());

  console.log("WORKSPACE", fs.readdirSync("/workspace"));

  runBenchmark();
}

bootstrap();

const ph = require("node:perf_hooks");

function runBenchmark() {
  console.log("=== 开始性能测试 ===");

  // 1. 测试小文件写入
  const t0 = ph.performance.now();
  fs.writeFileSync("/workspace/test", "Hello!!!", "utf8");
  const t1 = ph.performance.now();
  console.log(`1. 小文件写入耗时: ${(t1 - t0).toFixed(2)} ms`);

  // 2. 测试大文件内存分配开销
  const t2 = ph.performance.now();
  // Buffer.alloc 会在内存中把 100MB 全部用 'A' 填充，这本身就很消耗 CPU
  const largeBuffer = Buffer.alloc(100 * 1024 * 1024, "A");
  const t3 = ph.performance.now();
  console.log(`2. 100MB Buffer 内存分配耗时: ${(t3 - t2).toFixed(2)} ms`);

  // 3. 测试大文件同步写入
  const t4 = ph.performance.now();
  fs.writeFileSync("/workspace/large.bin", largeBuffer);
  const t5 = ph.performance.now();
  console.log(`3. 100MB 大文件同步写入耗时: ${(t5 - t4).toFixed(2)} ms`);

  // 4. 测试读取目录
  const t6 = ph.performance.now();
  const files = fs.readdirSync("/workspace");
  const t7 = ph.performance.now();
  console.log(`4. 读取目录耗时: ${(t7 - t6).toFixed(2)} ms`);

  console.log("\n当前目录文件:", files);
  console.log("====================");
}
