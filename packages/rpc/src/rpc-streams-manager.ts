import type { RPCDebugger } from "@/rpc-debugger";
import { RPCError } from "@/rpc-error";
import { RPCMessage } from "@/rpc-message";

export class RPCStreamsManager {
  #incoming: RPCStreamsManager.Incoming;
  #outgoing: RPCStreamsManager.Outgoing;

  #debugger?: RPCDebugger;

  constructor(sender: RPCStreamsManager.Sender, options?: RPCStreamsManager.Options) {
    this.#incoming = new RPCStreamsManager.Incoming(sender, options);
    this.#outgoing = new RPCStreamsManager.Outgoing(sender, options);

    this.#debugger = options?.debugger;
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
    this.#debugger?.debug("Received event", { type: event.body.type, id: event.body.id });

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
  /**
   * 管理所有从远端传入的流。
   * 它负责接收远端发送的流式数据帧(frame)、关闭(close)和错误(error)等事件，
   * 并将它们转换成本地可消费的 `ReadableStream` 对象。
   */
  export class Incoming {
    #streams: Map<
      string,
      {
        controller: ReadableStreamDefaultController<unknown>;
        clean: () => void;
      }
    >;
    #sender: Sender;

    #debugger?: RPCDebugger;

    constructor(sender: Sender, options?: Options) {
      this.#sender = sender;
      this.#streams = new Map();
      this.#debugger = options?.debugger;
    }

    #clean(id: string) {
      this.#streams.get(id)?.clean();
      this.#streams.delete(id);
    }

    /**
     * 创建一个新的传入流，并返回一个 `ReadableStream` 供本地消费者使用。
     *
     * 该流的生命周期与一个可选的 `AbortSignal` 绑定。当 `signal` 触发 `abort` 事件时，
     * 流将被错误终止，并通知远端此流已被取消。这通常发生在本地操作被取消（例如，用户关闭了相关UI）。
     *
     * 同样，如果本地消费者调用 `ReadableStream.cancel()`，也会通知远端取消相应的流。
     *
     * @param id 流的唯一标识符，由远端提供。
     * @param options 包含一个可选的 `AbortSignal`，用于将流的生命周期与外部操作关联起来。
     * @returns 一个 `ReadableStream`，可用于从远端接收数据。
     */
    create(id: string, options: IncomingOptions) {
      this.#debugger?.debug("Creating incoming stream", { id });

      if (this.#streams.has(id)) {
        throw new Error(`Incoming stream with ID "${id}" already exists.`);
      }

      return new ReadableStream<RPCMessage.Transferable>({
        start: (controller) => {
          const handleAbort = () => {
            const reason = signal?.reason || RPCError.createAborted("Stream aborted.");

            if (this.#streams.has(id)) {
              try {
                // 将流置为错误状态，以中断本地消费者的等待
                controller.error(reason);
              } catch {}

              // 通知远端我们不再接收数据
              this.#sender.send(RPCMessage.createStreamCanceledEvent(id));
              this.#clean(id);
            }
          };

          const signal = options.signal;

          this.#debugger?.debug("Incoming stream started", { id, hasSignal: !!signal });

          this.#streams.set(id, {
            controller,
            clean: () => {
              // 清理 signal 监听器，防止内存泄漏
              if (signal) {
                signal.removeEventListener("abort", handleAbort);
              }
            },
          });

          if (signal) {
            // 如果 signal 在流创建时已经处于 aborted 状态，则立即中止
            if (signal.aborted) {
              this.#debugger?.debug("Incoming stream aborted immediately", { id });
              return handleAbort();
            }

            signal.addEventListener("abort", handleAbort);
          }
        },
        cancel: () => {
          // 当本地消费者调用 stream.cancel() 时触发
          if (this.#streams.has(id)) {
            this.#debugger?.debug("Incoming stream canceled locally", { id });
            this.#sender.send(RPCMessage.createStreamCanceledEvent(id));
            this.#clean(id);
          }
        },
      });
    }

    /**
     * 检查是否存在具有指定 ID 的传入流。
     * @param id 要检查的流的 ID。
     * @returns 如果流存在则返回 `true`，否则返回 `false`。
     */
    has(id: string) {
      return this.#streams.has(id);
    }

    /**
     * 返回当前活动的传入流的数量。
     * @returns 活动流的数量。
     */
    count() {
      return this.#streams.size;
    }

    /**
     * 销毁所有活动的传入流，并用指定的错误通知所有流的消费者。
     * 这通常在 RPC 连接关闭时调用。
     * @param error 用于终止流的错误对象。
     */
    destroy(error: Error) {
      this.#debugger?.debug("Destroying all incoming streams", { count: this.#streams.size, error: error.message });

      for (const [_, { controller, clean }] of this.#streams.entries()) {
        try {
          controller.error(error);
        } catch {
          // 尽最大努力通知异常，忽略已经出错的流
        }

        clean();
      }

      this.#streams.clear();
    }

    /**
     * 处理来自远端的'stream:frame'事件。
     * 将接收到的数据块推入相应的 `ReadableStream` 控制器。
     * 如果流不存在或控制器已关闭，则忽略该数据。
     * @param id 流的 ID。
     * @param data 接收到的数据块。
     */
    handleFrame(id: string, data: unknown) {
      const controller = this.#streams.get(id)?.controller;

      if (!controller) {
        this.#debugger?.debug("Received frame for non-existent incoming stream", { id });
        return;
      }

      try {
        controller.enqueue(data);
      } catch (err) {
        this.#debugger?.debug("Failed to enqueue frame for incoming stream", { id, error: err });
        // 如果 enqueue 失败（例如，流已关闭或处于错误状态），
        // 必须显式地使 controller 抛出错误。这会中断本地消费者（Reader）的异步等待，防止死锁。
        try {
          controller.error(err);
        } catch {
          // 忽略 controller.error() 可能引发的二次错误
        }

        this.#clean(id);
      }
    }

    /**
     * 处理来自远端的'stream:closed'事件。
     * 正常关闭相应的 `ReadableStream`。如果流不存在，则忽略该事件。
     * @param id 要关闭的流的 ID。
     */
    handleClose(id: string) {
      const controller = this.#streams.get(id)?.controller;

      if (!controller) {
        this.#debugger?.debug("Received close for non-existent incoming stream", { id });
        return;
      }

      this.#debugger?.debug("Closing incoming stream", { id });

      try {
        controller.close();
      } catch {
        // 忽略因重复关闭而引发的异常
      } finally {
        this.#clean(id);
      }
    }

    /**
     * 处理来自远端的'stream:error'事件。
     * 使相应的 `ReadableStream` 进入错误状态。如果流不存在，则忽略该事件。
     * @param id 流的 ID。
     * @param error 从远端接收到的错误信息。
     */
    handleError(id: string, error: RPCMessage.Error) {
      const controller = this.#streams.get(id)?.controller;

      if (!controller) {
        this.#debugger?.debug("Received error for non-existent incoming stream", { id });
        return;
      }

      this.#debugger?.debug("Handling error for incoming stream", { id, error });

      try {
        controller.error(RPCError.fromTransferable(error));
      } catch {
        // 忽略向已处于错误状态的流再次发送错误的异常
      } finally {
        this.#clean(id);
      }
    }
  }

  /**
   * 管理所有向远端传出的流。
   * 它负责读取本地提供的 `ReadableStream`，将其内容分块成数据帧(frame)并发送到远端。
   * 同时，它也处理来自远端的流取消请求。
   */
  export class Outgoing {
    #streams: Map<
      string,
      {
        reader: ReadableStreamDefaultReader<RPCMessage.Transferable>;
        clean: () => void;
      }
    >;
    #sender: Sender;

    #debugger?: RPCDebugger;

    constructor(sender: Sender, options?: Options) {
      this.#sender = sender;
      this.#streams = new Map();
      this.#debugger = options?.debugger;
    }

    #clean(id: string) {
      this.#streams.get(id)?.clean();
      this.#streams.delete(id);
    }

    /**
     * 创建一个新的传出流，用于将本地 `ReadableStream` 的数据发送到远端。
     *
     * 此方法会立即返回一个流ID，并启动一个异步的推流循环。该循环负责从本地流中读取数据，
     * 并通过 `stream:frame` 事件发送到远端。
     *
     * 流的生命周期与一个可选的 `AbortSignal` 绑定。当 `signal` 触发 `abort` 事件时，
     * 推流循环将停止，并向远端发送一个 `stream:error` 事件，以通知远端流已非正常终止。
     * 这种机制主要用于处理本地操作被取消的场景。
     *
     * @param stream 要发送到远端的 `ReadableStream`。
     * @param options 包含一个可选的 `AbortSignal`，用于将流的生命周期与外部操作关联起来。
     * @returns 分配给此流的唯一 ID。
     */
    create(stream: ReadableStream<RPCMessage.Transferable>, options: OutgoingOptions) {
      const id = crypto.randomUUID();
      this.#debugger?.debug("Creating outgoing stream", { id });

      const reader = stream.getReader();

      const signal = options.signal;
      const handleAbort = () => {
        const reason = signal?.reason || RPCError.createAborted("Stream aborted.");

        if (this.#streams.has(id)) {
          this.#debugger?.debug("Outgoing stream aborted", { id, reason });

          // 取消对本地流的读取
          reader.cancel(reason).catch(() => {});

          this.#clean(id);

          // 当通过 AbortSignal 触发取消时，我们无法判断取消的具体来源（是本地还是其他原因）。
          // 在这种情况下，我们默认是本地发送方主动终止了输出流。
          // 因此，我们向远端发送一个 `stream:error` 事件，告知远端流已中止。
          this.#sender.send(RPCMessage.createStreamErrorEvent(id, RPCError.fromUnknown(reason, RPCError.Code.Aborted).transferable()));
        }
      };

      this.#streams.set(id, {
        reader,
        clean: () => {
          if (signal) {
            signal.removeEventListener("abort", handleAbort);
          }
        },
      });

      this.#debugger?.debug("Outgoing stream registered", { id, hasSignal: !!signal });

      if (signal) {
        if (signal.aborted) {
          this.#debugger?.debug("Outgoing stream aborted immediately", { id });
          handleAbort();
        } else {
          signal.addEventListener("abort", handleAbort);
        }
      }

      // 启动异步推流循环，不阻塞当前执行线程
      (async () => {
        this.#debugger?.debug("Starting push loop for outgoing stream", { id });

        try {
          while (true) {
            // 在每次读取前，检查流是否仍然有效。
            // 流可能在等待 `reader.read()` 的过程中被远端取消（通过 handleCancel）。
            if (!this.#streams.has(id)) {
              this.#debugger?.debug("Outgoing stream no longer exists during read", { id });
              break;
            }

            const { done, value } = await reader.read();

            // 再次进行安全检查，确保在 `await reader.read()` 期间流没有被取消。
            if (!this.#streams.has(id)) {
              this.#debugger?.debug("Outgoing stream canceled during read", { id });
              break;
            }

            if (done) {
              // 本地流已成功读取完毕，通知远端关闭
              this.#debugger?.debug("Outgoing stream completed", { id });
              this.#sender.send(RPCMessage.createStreamClosedEvent(id));
              break;
            }

            // 将数据帧发送到远端
            this.#sender.send(RPCMessage.createStreamFrameEvent(id, value));
          }
        } catch (err) {
          // 如果在读取或处理过程中发生错误，且流仍然有效，则通知远端
          if (this.#streams.has(id)) {
            this.#debugger?.debug("Error in outgoing stream", { id, error: err });
            this.#sender.send(RPCMessage.createStreamErrorEvent(id, RPCError.fromUnknown(err, RPCError.Code.Internal).transferable()));
          }

          // 确保 reader 被取消，以释放资源
          reader.cancel(err).catch(() => {});
        } finally {
          this.#debugger?.debug("Cleaning up outgoing stream", { id });
          this.#clean(id);

          // 释放 reader 上的锁
          try {
            reader.releaseLock();
          } catch {}
        }
      })();

      return id;
    }

    /**
     * 检查是否存在具有指定 ID 的传出流。
     * @param id 要检查的流的 ID。
     * @returns 如果流存在则返回 `true`，否则返回 `false`。
     */
    has(id: string) {
      return this.#streams.has(id);
    }

    /**
     * 返回当前活动的传出流的数量。
     * @returns 活动流的数量。
     */
    count() {
      return this.#streams.size;
    }

    /**
     * 销毁所有活动的传出流，并取消对本地 `ReadableStream` 的读取。
     * 这通常在 RPC 连接关闭时调用。
     * @param error 用于终止流的错误对象。
     */
    destroy(error: Error) {
      this.#debugger?.debug("Destroying all outgoing streams", { count: this.#streams.size, error: error.message });

      for (const [_, { reader, clean }] of this.#streams.entries()) {
        reader.cancel(error).catch(() => {});
        clean();
      }

      this.#streams.clear();
    }

    /**
     * 处理来自远端的'stream:canceled'事件。
     * 这会取消对相应本地 `ReadableStream` 的读取，并清理相关资源。
     * 这通常发生在远端消费者不再需要数据时。
     * @param id 被取消的流的 ID。
     */
    handleCancel(id: string) {
      const reader = this.#streams.get(id)?.reader;

      if (!reader) {
        this.#debugger?.debug("Received cancel for non-existent outgoing stream", { id });
        return;
      }

      this.#debugger?.debug("Handling cancel for outgoing stream", { id });

      this.#clean(id);

      // 远端已经确认取消，因此我们只需在本地取消 reader 即可。
      // 无需再向远端发送任何确认消息，因为远端已经认为流已终止。
      reader.cancel(RPCError.createCanceled("Stream canceled by remote side.")).catch(() => {});
    }
  }

  export type Sender = {
    send(message: RPCMessage.Event): void;
  };

  export type IncomingOptions = { signal?: AbortSignal };
  export type OutgoingOptions = { signal?: AbortSignal };

  export type Options = {
    debugger?: RPCDebugger;
  };
}
