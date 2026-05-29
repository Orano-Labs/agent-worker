import { oc } from "@orpc/contract";
import { z } from "zod/v4";

export namespace Supervisor {
  export const CONTROLLER_CONTRACT = {
    host: {
      /**
       * 获取当前主机的硬件与资源负载状态 (Director -> Supervisor)
       */
      status: oc.input(z.void()).output(z.object({})),
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
