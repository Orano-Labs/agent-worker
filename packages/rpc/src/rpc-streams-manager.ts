import { RPCError } from "@/rpc-error";
import { RPCMessage } from "@/rpc-message";

export class RPCStreamsManager {
  #incoming: RPCStreamsManager.Incoming;
  #outgoing: RPCStreamsManager.Outgoing;

  constructor(sender: RPCStreamsManager.Sender) {
    this.#incoming = new RPCStreamsManager.Incoming(sender);
    this.#outgoing = new RPCStreamsManager.Outgoing(sender);
  }

  get incoming() {
    return this.#incoming;
  }

  get outgoing() {
    return this.#outgoing;
  }

  destroy(error: Error) {
    this.#incoming.destroy(error);
    this.#outgoing.destroy(error);
  }

  handle(event: RPCMessage.Event) {
    switch (event.body.type) {
      case "stream:canceled":
        this.#outgoing.handleCancel(event.body.id);
        break;

      case "stream:closed":
        this.#incoming.handleClose(event.body.id);
        break;

      case "stream:error":
        this.#incoming.handleError(event.body.id, event.body.error);
        break;

      case "stream:frame":
        this.#incoming.handleFrame(event.body.id, event.body.data);
        break;
    }
  }

  createIncoming(id: string, options: RPCStreamsManager.IncomingOptions) {
    return this.#incoming.create(id, options);
  }

  createOutgoing(stream: ReadableStream<RPCMessage.Transferable>, options: RPCStreamsManager.OutgoingOptions) {
    return this.#outgoing.create(stream, options);
  }
}

export namespace RPCStreamsManager {
  export class Incoming {
    #streams: Map<
      string,
      {
        controller: ReadableStreamDefaultController<unknown>;
        clean: () => void;
      }
    >;
    #sender: Sender;

    constructor(sender: Sender) {
      this.#sender = sender;
      this.#streams = new Map();
    }

    #clean(id: string) {
      this.#streams.get(id)?.clean();
      this.#streams.delete(id);
    }

    create(id: string, options: IncomingOptions) {
      if (this.#streams.has(id)) {
        throw new Error(`Incoming stream with ID "${id}" already exists.`);
      }

      return new ReadableStream<RPCMessage.Transferable>({
        start: (controller) => {
          this.#streams.set(id, {
            controller,
            clean: () => {
              if (signal) {
                signal.removeEventListener("abort", handleAbort);
              }
            },
          });

          const handleAbort = (reason: unknown) => {
            if (this.#streams.has(id)) {
              try {
                controller.error(reason);
              } catch {}

              this.#sender.send(RPCMessage.createStreamCanceledEvent(id));
              this.#clean(id);
            }
          };

          const signal = options.signal;

          if (signal) {
            if (signal.aborted) {
              return handleAbort(signal.reason);
            }

            signal.addEventListener("abort", handleAbort);
          }
        },
        cancel: () => {
          if (this.#streams.has(id)) {
            this.#sender.send(RPCMessage.createStreamCanceledEvent(id));
            this.#clean(id);
          }
        },
      });
    }

    has(id: string) {
      return this.#streams.has(id);
    }

    count() {
      return this.#streams.size;
    }

    destroy(error: Error) {
      for (const [_, { controller, clean }] of this.#streams.entries()) {
        try {
          controller.error(error);
        } catch {
          // 尽最大努力通知异常
        }

        clean();
      }

      this.#streams.clear();
    }

    handleFrame(id: string, data: unknown) {
      const controller = this.#streams.get(id)?.controller;

      if (!controller) {
        return;
      }

      try {
        controller.enqueue(data);
      } catch (err) {
        // 必须显式使 controller 抛错，打破本地消费者(Reader)的异步等待，避免死锁。
        try {
          controller.error(err);
        } catch {
          // 忽略二次报错
        }

        this.#clean(id);
      }
    }

    handleClose(id: string) {
      const controller = this.#streams.get(id)?.controller;

      if (!controller) {
        return;
      }

      try {
        controller.close();
      } catch {
        // 忽略重复关闭的异常
      } finally {
        this.#clean(id);
      }
    }

    handleError(id: string, error: RPCMessage.Error) {
      const controller = this.#streams.get(id)?.controller;

      if (!controller) {
        return;
      }

      try {
        controller.error(RPCError.fromTransferable(error));
      } catch {
        // 忽略已处于错误状态的流
      } finally {
        this.#clean(id);
      }
    }
  }

  export class Outgoing {
    #streams: Map<
      string,
      {
        reader: ReadableStreamDefaultReader<RPCMessage.Transferable>;
        clean: () => void;
      }
    >;
    #sender: Sender;

    constructor(sender: Sender) {
      this.#sender = sender;
      this.#streams = new Map();
    }

    #clean(id: string) {
      this.#streams.get(id)?.clean();
      this.#streams.delete(id);
    }

    create(stream: ReadableStream<RPCMessage.Transferable>, options: OutgoingOptions) {
      const id = crypto.randomUUID();
      const reader = stream.getReader();

      this.#streams.set(id, {
        reader,
        clean: () => {
          if (signal) {
            signal.removeEventListener("abort", handleAbort);
          }
        },
      });

      const signal = options.signal;
      const handleAbort = () => {
        const reason = signal?.reason || new Error("Stream aborted.");

        if (this.#streams.has(id)) {
          reader.cancel(reason).catch(() => {});

          this.#clean(id);

          // 当通过 AbortSignal 触发取消时；无法判断具体的取消来源
          // 所以默认为发送端主动终止了输出流；并向远端发送流错误事件
          this.#sender.send(RPCMessage.createStreamErrorEvent(id, RPCError.fromUnknown(reason, RPCError.Code.Aborted).transferable()));
        }
      };

      if (signal) {
        signal.addEventListener("abort", handleAbort);

        if (signal.aborted) {
          handleAbort();
        }
      }

      // 开启异步推流循环（不阻塞当前主线程）
      (async () => {
        try {
          while (true) {
            // 在读取前，先验证该流是否还存在于 Map 中（是否已被远端 handleCancel 取消）
            if (!this.#streams.has(id)) {
              break;
            }

            const { done, value } = await reader.read();

            // 再次安全检查，防止在 await reader.read() 期间远端发来了取消信号
            if (!this.#streams.has(id)) {
              break;
            }

            if (done) {
              // 本地流正常结束，通知远端关闭
              return this.#sender.send(RPCMessage.createStreamClosedEvent(id));
            }

            // 发送数据帧到网络层
            this.#sender.send(RPCMessage.createStreamFrameEvent(id, value));
          }
        } catch (err) {
          if (this.#streams.has(id)) {
            this.#sender.send(RPCMessage.createStreamErrorEvent(id, RPCError.fromUnknown(err, RPCError.Code.Internal).transferable()));
          }

          reader.cancel(err).catch(() => {});
        } finally {
          this.#clean(id);

          try {
            reader.releaseLock();
          } catch {}
        }
      })();

      return id;
    }

    has(id: string) {
      return this.#streams.has(id);
    }

    count() {
      return this.#streams.size;
    }

    destroy(error: Error) {
      for (const [_, { reader }] of this.#streams.entries()) {
        reader.cancel(error).catch(() => {});
      }

      this.#streams.clear();
    }

    handleCancel(id: string) {
      const reader = this.#streams.get(id)?.reader;

      if (!reader) {
        return;
      }

      this.#clean(id);

      // 如果是从远端取消的，不再向远端发送任何消息
      // 包括流被取消的信息；因为默认远端已经处理了输入流的取消
      reader.cancel(RPCError.createCanceled("Stream canceled by remote side.")).catch(() => {});
    }
  }

  export type Sender = {
    send(message: RPCMessage.Event): void;
  };

  export type IncomingOptions = { signal?: AbortSignal };
  export type OutgoingOptions = { signal?: AbortSignal };
}
