import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

// 获取命令行挂载路径参数
const WORKSPACE = "/workspace";
const TEST_DIR = path.join(WORKSPACE, `node_fs_test_${Date.now()}`);

// 生成随机 Buffer
function generateRandomBuffer(sizeInBytes) {
  return crypto.randomBytes(sizeInBytes);
}

// 延迟函数
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

async function runBenchmark() {
  console.log(`==================================================`);
  console.log(`🚀 开始 davfs2 性能与可靠性测试`);
  console.log(`目标路径: ${TEST_DIR}`);
  console.log(`==================================================\n`);

  try {
    // 初始化测试目录
    await fs.mkdir(TEST_DIR, { recursive: true });

    // --- 测试 1: 大文件顺序读写与一致性 (吞吐量测试) ---
    console.log(`[测试 1] 大文件顺序读写测试 (50MB)...`);
    const bigFileSize = 50 * 1024 * 1024; // 50MB
    const bigFilePayload = generateRandomBuffer(bigFileSize);
    const bigFilePath = path.join(TEST_DIR, "big_file.bin");

    // 写测试
    let startTime = Date.now();
    await fs.writeFile(bigFilePath, bigFilePayload);
    let duration = (Date.now() - startTime) / 1000;
    console.log(`   ✓ 写入 50MB 耗时: ${duration.toFixed(2)} 秒 (${(50 / duration).toFixed(2)} MB/s)`);

    // 读测试与 MD5 校验
    startTime = Date.now();
    const readBuffer = await fs.readFile(bigFilePath);
    duration = (Date.now() - startTime) / 1000;
    console.log(`   ✓ 读取 50MB 耗时: ${duration.toFixed(2)} 秒 (${(50 / duration).toFixed(2)} MB/s)`);

    const originalHash = crypto.createHash("md5").update(bigFilePayload).digest("hex");
    const readHash = crypto.createHash("md5").update(readBuffer).digest("hex");

    if (originalHash === readHash) {
      console.log(`   验证: 数据一致性校验成功 (MD5 匹配)`);
    } else {
      console.error(`   ❌ 警告: 数据损坏！MD5 不匹配！`);
    }
    console.log(`--------------------------------------------------`);

    // --- 测试 2: 密集小文件并发写入 (可靠性/压力测试) ---
    // 注意：davfs2 对并发极度敏感，这里限制并发数为 5，防止网络栈直接假死
    console.log(`[测试 2] 并发小文件写入测试 (200 个 10KB 文件)...`);
    const smallFileSize = 10 * 1024; // 10KB
    const totalFiles = 200;
    const concurrencyLimit = 5;
    const fileList = Array.from({ length: totalFiles }, (_, i) => `small_${i}.txt`);

    startTime = Date.now();

    // 限制并发的异步池处理
    for (let i = 0; i < fileList.length; i += concurrencyLimit) {
      const chunk = fileList.slice(i, i + concurrencyLimit);
      await Promise.all(
        chunk.map(async (filename) => {
          const filePath = path.join(TEST_DIR, filename);
          const data = generateRandomBuffer(smallFileSize);
          await fs.writeFile(filePath, data);
        }),
      );
    }

    duration = (Date.now() - startTime) / 1000;
    console.log(`   ✓ 成功并发写入 ${totalFiles} 个小文件.`);
    console.log(`   ✓ 耗时: ${duration.toFixed(2)} 秒 (${(totalFiles / duration).toFixed(2)} 文件/秒)`);
    console.log(`--------------------------------------------------`);

    // --- 测试 3: 目录遍历 (Metadata 性能测试) ---
    console.log(`[测试 3] 目录检索 (readdir) 测试...`);
    startTime = Date.now();
    const files = await fs.readdir(TEST_DIR);
    duration = (Date.now() - startTime) / 1000;
    console.log(`   ✓ 成功读取目录，发现 ${files.length} 个文件.`);
    console.log(`   ✓ 耗时: ${duration.toFixed(2)} 秒`);
    console.log(`--------------------------------------------------`);

    // --- 测试 4: 密集删除测试 (清理与稳定性) ---
    console.log(`[测试 4] 文件删除与清理测试...`);
    startTime = Date.now();

    // 同样限制并发进行删除
    for (let i = 0; i < files.length; i += concurrencyLimit) {
      const chunk = files.slice(i, i + concurrencyLimit);
      await Promise.all(
        chunk.map(async (filename) => {
          await fs.unlink(path.join(TEST_DIR, filename));
        }),
      );
    }

    // 删除测试根目录
    await fs.rmdir(TEST_DIR);

    duration = (Date.now() - startTime) / 1000;
    console.log(`   ✓ 成功清理所有测试文件和目录.`);
    console.log(`   ✓ 耗时: ${duration.toFixed(2)} 秒`);
    console.log(`==================================================`);
    console.log(`🎉 测试顺利完成！davfs2 表现稳定。`);
    console.log(`==================================================`);
  } catch (error) {
    console.error(`\n❌ 测试期间发生崩溃!! 这通常意味着 davfs2 挂载点在压力下断开了。`);
    console.error(`错误详情:`, error.message);
    console.log(
      `\n提示: 建议检查 'dmesg' 或 '/var/log/syslog'，查看是否出现了 FUSE 锁死或 WebDAV 423 Locked / 503 Service Unavailable 错误。`,
    );
  }
}

runBenchmark();
