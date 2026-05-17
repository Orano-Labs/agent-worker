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

      case "request:canceled":
        this.#incoming.handleRequestCanceled(event.body.id);
        this.#outgoing.handleRequestCanceled(event.body.id);
        break;
    }
  }

  createIncoming(id: string, owner: RPCStreamsManager.Owner) {
    return this.#incoming.create(id, owner);
  }

  createOutgoing(stream: ReadableStream<RPCMessage.Transferable>, owner: RPCStreamsManager.Owner) {
    return this.#outgoing.create(stream, owner);
  }
}

export namespace RPCStreamsManager {
  export class Incoming {
    #controllers: Map<
      string,
      {
        controller: ReadableStreamDefaultController<unknown>;
        owner: RPCStreamsManager.Owner;
      }
    >;
    #sender: Sender;

    constructor(sender: Sender) {
      this.#sender = sender;
      this.#controllers = new Map();
    }

    create(id: string, owner: RPCStreamsManager.Owner) {
      if (this.#controllers.has(id)) {
        throw new Error(`Incoming stream with ID "${id}" already exists.`);
      }

      return new ReadableStream<RPCMessage.Transferable>({
        start: (controller) => {
          this.#controllers.set(id, {
            controller,
            owner,
          });
        },
        cancel: () => {
          this.#controllers.delete(id);
          this.#sender.send(RPCMessage.createStreamCanceledEvent(id));
        },
      });
    }

    has(id: string) {
      return this.#controllers.has(id);
    }

    count() {
      return this.#controllers.size;
    }

    destroy(error: Error) {
      for (const [_, { controller }] of this.#controllers.entries()) {
        try {
          controller.error(error);
        } catch {
          // 尽最大努力通知异常
        }
      }

      this.#controllers.clear();
    }

    handleFrame(id: string, data: unknown) {
      const controller = this.#controllers.get(id)?.controller;

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

        this.#controllers.delete(id);
      }
    }

    handleClose(id: string) {
      const controller = this.#controllers.get(id)?.controller;

      if (!controller) {
        return;
      }

      try {
        controller.close();
      } catch {
        // 忽略重复关闭的异常
      } finally {
        this.#controllers.delete(id);
      }
    }

    handleError(id: string, error: RPCMessage.Error) {
      const controller = this.#controllers.get(id)?.controller;

      if (!controller) {
        return;
      }

      try {
        controller.error(RPCError.fromTransferable(error));
      } catch {
        // 忽略已处于错误状态的流
      } finally {
        this.#controllers.delete(id);
      }
    }

    handleRequestCanceled(request: string) {
      for (const [id, { owner, controller }] of this.#controllers.entries()) {
        if (request !== owner.id) {
          continue;
        }

        try {
          controller.error(RPCError.createAborted("Request canceled."));
        } catch {
          // 忽略已处于错误状态的流
        } finally {
          this.#controllers.delete(id);
        }
      }
    }
  }

  export class Outgoing {
    #readers: Map<
      string,
      {
        reader: ReadableStreamDefaultReader<RPCMessage.Transferable>;
        owner: RPCStreamsManager.Owner;
      }
    >;
    #sender: Sender;

    constructor(sender: Sender) {
      this.#sender = sender;
      this.#readers = new Map();
    }

    create(stream: ReadableStream<RPCMessage.Transferable>, owner: RPCStreamsManager.Owner) {
      const id = crypto.randomUUID();
      const reader = stream.getReader();

      this.#readers.set(id, { reader, owner });

      // 开启异步推流循环（不阻塞当前主线程）
      (async () => {
        try {
          while (true) {
            // 在读取前，先验证该流是否还存在于 Map 中（是否已被远端 handleCancel 取消）
            if (!this.#readers.has(id)) {
              break;
            }

            const { done, value } = await reader.read();

            if (done) {
              // 本地流正常结束，通知远端关闭
              return this.#sender.send(RPCMessage.createStreamClosedEvent(id));
            }

            // 再次安全检查，防止在 await reader.read() 期间远端发来了取消信号
            if (!this.#readers.has(id)) {
              break;
            }

            // 发送数据帧到网络层
            this.#sender.send(RPCMessage.createStreamFrameEvent(id, value));
          }
        } catch (err) {
          this.#sender.send(RPCMessage.createStreamErrorEvent(id, RPCError.fromUnknown(err, RPCError.Code.Internal).transferable()));
        } finally {
          reader.releaseLock();
          this.#readers.delete(id);
        }
      })();

      return id;
    }

    has(id: string) {
      return this.#readers.has(id);
    }

    count() {
      return this.#readers.size;
    }

    destroy(error: Error) {
      for (const [_, { reader }] of this.#readers.entries()) {
        reader.cancel(error).catch(() => {});
      }

      this.#readers.clear();
    }

    handleCancel(id: string) {
      const reader = this.#readers.get(id)?.reader;

      if (!reader) {
        return;
      }

      reader.cancel(RPCError.createCanceled("Stream canceled by remote side.")).catch(() => {});

      this.#readers.delete(id);
    }

    handleRequestCanceled(request: string) {
      for (const [id, { owner, reader }] of this.#readers.entries()) {
        if (request !== owner.id) {
          continue;
        }

        reader.cancel(RPCError.createCanceled("Request canceled.")).catch(() => {});

        this.#readers.delete(id);
      }
    }
  }

  export type Sender = {
    send(message: RPCMessage.Event): void;
  };

  export type Owner = {
    id: string;
    type: "request" | "response";
  };
}
