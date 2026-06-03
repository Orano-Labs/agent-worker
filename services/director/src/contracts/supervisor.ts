import { oc } from "@orpc/contract";
import { z } from "zod/v4";

export namespace Supervisor {
  export const CONTROLLER_CONTRACT = {
    host: {
      /**
       * Get the current hardware and resource load status of the host
       */
      status: oc.input(z.object({})).output(
        z.object({
          // State reporting timestamp in milliseconds
          ts: z.number().int(),
          // System uptime in seconds
          uptime: z.number(),

          cpu: z.object({
            // Number of logical cores
            cores: z.number().int(),
            // Total CPU usage percentage (0-100)
            usagePercent: z.number().min(0).max(100),
            // Linux load average for [1min, 5min, 15min]
            loadAvg: z.tuple([z.number(), z.number(), z.number()]),
          }),

          memory: z.object({
            // Total memory in bytes
            totalBytes: z.number().int(),
            // Used memory in bytes
            usedBytes: z.number().int(),
            // Free memory available in bytes
            freeBytes: z.number().int(),
            // Memory usage percentage (0-100)
            usagePercent: z.number().min(0).max(100),
          }),

          // List of disk partition statuses
          disk: z
            .object({
              // Mount point (e.g., '/', '/data')
              mountPoint: z.string(),
              // Total disk capacity in bytes
              totalBytes: z.number().int(),
              // Used disk space in bytes
              usedBytes: z.number().int(),
              // Disk space usage percentage (0-100)
              usagePercent: z.number().min(0).max(100),
              // Disk read rate in Bytes/s
              ioReadBytesPerSec: z.number(),
              // Disk write rate in Bytes/s
              ioWriteBytesPerSec: z.number(),
            })
            .array(),

          network: z.object({
            // Network rx (receive) rate in Bytes/s
            rxBytesPerSec: z.number(),
            // Network tx (transmit) rate in Bytes/s
            txBytesPerSec: z.number(),
            // Number of currently active network connections
            connections: z.number(),
          }),
        }),
      ),
    },

    task: {
      /**
       * 尝试向 Supervisor 派发并拉起一个短任务 (Director -> Supervisor)
       */
      dispatch: oc.input(z.object({})).output(z.object({})),
      /**
       * 强制二次校准/同步指定任务的真实状态 (Director -> Supervisor)
       * 场景：当 Director 重启、网络闪断，或者 Director 怀疑某个任务已经死掉（由于长时间没收到日志）时，
       * 主动向 Supervisor 质询该任务在内核/Firecracker 进程层面的真实状态。
       */
      inspect: oc.input(z.object({})).output(z.object({})),
      /**
       * 强行终止一个正在执行的任务
       */
      terminate: oc.input(z.object({})).output(z.void()),
    },
  } as const;

  export const PORT_CONTRACT = {};
}
