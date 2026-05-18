import { beforeEach, describe, expect, test, vi } from "vitest";

import { RPCError } from "@/rpc-error";
import { RPCMessage } from "@/rpc-message";
import { RPCStreamsManager } from "@/rpc-streams-manager";

import Incoming = RPCStreamsManager.Incoming;
import Outgoing = RPCStreamsManager.Outgoing;

describe("RPCStreamsManager", () => {
  let sender = {
    send: vi.fn<RPCStreamsManager.Sender["send"]>(),
  };

  beforeEach(() => {
    sender = {
      send: vi.fn<RPCStreamsManager.Sender["send"]>(),
    };
  });

  describe("Incoming", () => {
    let incoming: Incoming;

    beforeEach(() => {
      incoming = new Incoming(sender);
    });

    test("should create a new stream", () => {
      const stream = incoming.create("test-stream", {});

      expect(stream).toBeInstanceOf(ReadableStream);
      expect(incoming.has("test-stream")).toBe(true);
      expect(incoming.count()).toBe(1);
    });

    test("should throw an error if stream ID already exists", () => {
      expect(() => {
        incoming.create("test-stream", {});
        incoming.create("test-stream", {});
      }).toThrow('Incoming stream with ID "test-stream" already exists.');
    });

    test("should handle stream cancellation", async () => {
      const stream = incoming.create("test-stream", {});

      await stream.cancel();

      expect(incoming.has("test-stream")).toBe(false);
      expect(sender.send).toHaveBeenCalledWith(RPCMessage.createStreamCanceledEvent("test-stream"));
    });

    test("should handle incoming data frames", async () => {
      const stream = incoming.create("test-stream", {});
      const reader = stream.getReader();

      incoming.handleFrame("test-stream", "hello");

      const chunk = await reader.read();

      expect(chunk.value).toBe("hello");
    });

    test("should do nothing if stream does not exist when handling frame", () => {
      incoming.handleFrame("non-existent-stream", "hello");
      expect(sender.send).not.toHaveBeenCalled();
    });

    test("should handle stream closure", async () => {
      const stream = incoming.create("test-stream", {});
      const reader = stream.getReader();

      incoming.handleClose("test-stream");

      const chunk = await reader.read();

      expect(chunk.done).toBe(true);
      expect(incoming.has("test-stream")).toBe(false);
    });

    test("should do nothing if stream does not exist when handling close", () => {
      incoming.handleClose("non-existent-stream");
      expect(incoming.count()).toBe(0);
    });

    test("should handle stream errors", async () => {
      const stream = incoming.create("test-stream", {});
      const reader = stream.getReader();
      const error = { code: RPCError.Code.Unknown, message: "Something went wrong" };

      incoming.handleError("test-stream", error);

      await expect(reader.read()).rejects.toThrow(error.message);

      expect(incoming.has("test-stream")).toBe(false);
    });

    test("should do nothing if stream does not exist when handling error", () => {
      const error = { code: RPCError.Code.Unknown, message: "Something went wrong" };

      incoming.handleError("non-existent-stream", error);

      expect(incoming.count()).toBe(0);
    });

    test("should destroy all streams", async () => {
      const stream1 = incoming.create("stream1", {});
      const stream2 = incoming.create("stream2", {});
      const reader1 = stream1.getReader();
      const reader2 = stream2.getReader();

      const error = new Error("Destroyed");

      incoming.destroy(error);

      await expect(reader1.read()).rejects.toThrow(error);
      await expect(reader2.read()).rejects.toThrow(error);

      expect(incoming.count()).toBe(0);
    });

    test("should cancel stream when signal is aborted", async () => {
      const abortController = new AbortController();
      const stream = incoming.create("test-stream", { signal: abortController.signal });
      const reader = stream.getReader();

      abortController.abort();

      await expect(reader.read()).rejects.toThrow();

      expect(incoming.has("test-stream")).toBe(false);
      expect(sender.send).toHaveBeenCalledWith(RPCMessage.createStreamCanceledEvent("test-stream"));
    });

    test("should not create stream if signal is already aborted", async () => {
      const abortController = new AbortController();

      abortController.abort();

      const stream = incoming.create("test-stream", { signal: abortController.signal });
      const reader = stream.getReader();

      await expect(reader.read()).rejects.toThrow();

      expect(incoming.has("test-stream")).toBe(false);
      expect(sender.send).toHaveBeenCalledWith(RPCMessage.createStreamCanceledEvent("test-stream"));
    });

    test("should remove abort listener when stream is cancelled manually", async () => {
      const abortController = new AbortController();
      const stream = incoming.create("test-stream", { signal: abortController.signal });

      await stream.cancel();

      abortController.abort();

      expect(sender.send).toHaveBeenCalledTimes(1);
      expect(sender.send).toHaveBeenCalledWith(RPCMessage.createStreamCanceledEvent("test-stream"));
    });

    test("should remove abort listener when stream is closed normally", async () => {
      const abortController = new AbortController();

      incoming.create("test-stream", { signal: abortController.signal });
      incoming.handleClose("test-stream");

      abortController.abort();

      expect(sender.send).not.toHaveBeenCalledWith(RPCMessage.createStreamCanceledEvent("test-stream"));
    });

    test("should remove abort listener when stream errors", async () => {
      const abortController = new AbortController();

      incoming.create("test-stream", { signal: abortController.signal });
      incoming.handleError("test-stream", { code: RPCError.Code.Unknown, message: "Remote error" });

      abortController.abort();

      expect(sender.send).not.toHaveBeenCalledWith(RPCMessage.createStreamCanceledEvent("test-stream"));
    });

    test("should handle multiple streams independently", async () => {
      const stream1 = incoming.create("stream1", {});
      const stream2 = incoming.create("stream2", {});
      const reader1 = stream1.getReader();
      const reader2 = stream2.getReader();

      incoming.handleFrame("stream1", "data1");
      incoming.handleFrame("stream2", "data2");

      const result1 = await reader1.read();
      const result2 = await reader2.read();

      expect(result1.value).toBe("data1");
      expect(result2.value).toBe("data2");
      expect(incoming.count()).toBe(2);
    });

    test("should ignore duplicate close calls", () => {
      incoming.create("test-stream", {});

      incoming.handleClose("test-stream");
      incoming.handleClose("test-stream");

      expect(incoming.count()).toBe(0);
    });

    test("should ignore duplicate error calls", () => {
      incoming.create("test-stream", {});
      const error = { code: RPCError.Code.Unknown, message: "Error" };

      incoming.handleError("test-stream", error);
      incoming.handleError("test-stream", error);

      expect(incoming.count()).toBe(0);
    });

    test("should handle frame after stream closed", () => {
      incoming.create("test-stream", {});

      incoming.handleClose("test-stream");
      incoming.handleFrame("test-stream", "data");

      expect(incoming.count()).toBe(0);
    });

    test("should handle frame after stream error", () => {
      incoming.create("test-stream", {});
      const error = { code: RPCError.Code.Unknown, message: "Error" };

      incoming.handleError("test-stream", error);
      incoming.handleFrame("test-stream", "data");

      expect(incoming.count()).toBe(0);
    });

    test("should handle destroy with no streams", () => {
      expect(() => incoming.destroy(new Error("test"))).not.toThrow();
      expect(incoming.count()).toBe(0);
    });

    test("should handle destroy with multiple error types", async () => {
      const stream1 = incoming.create("stream1", {});
      const stream2 = incoming.create("stream2", {});
      const reader1 = stream1.getReader();
      const reader2 = stream2.getReader();

      const error = new TypeError("Custom error");
      incoming.destroy(error);

      await expect(reader1.read()).rejects.toThrow(TypeError);
      await expect(reader2.read()).rejects.toThrow("Custom error");
    });

    test("should clean up resources when destroy is called", () => {
      const abortController = new AbortController();
      incoming.create("stream1", { signal: abortController.signal });
      incoming.create("stream2", {});

      const destroyError = new Error("Destroy all");
      incoming.destroy(destroyError);

      expect(incoming.count()).toBe(0);

      // abort 不应该再有任何影响
      abortController.abort();
      expect(sender.send).not.toHaveBeenCalled();
    });

    test("should not leak memory when many streams are created and destroyed", () => {
      const streamCount = 100;

      for (let i = 0; i < streamCount; i++) {
        incoming.create(`stream-${i}`, {});
      }

      expect(incoming.count()).toBe(streamCount);

      for (let i = 0; i < streamCount; i++) {
        incoming.handleClose(`stream-${i}`);
      }

      expect(incoming.count()).toBe(0);
    });

    test("should handle rapid create and cancel", async () => {
      const promises = [];

      for (let i = 0; i < 50; i++) {
        const stream = incoming.create(`stream-${i}`, {});
        promises.push(stream.cancel());
      }

      await Promise.all(promises);
      expect(incoming.count()).toBe(0);
    });

    test("should handle interleaved operations", async () => {
      const stream1 = incoming.create("stream1", {});
      const stream2 = incoming.create("stream2", {});
      const reader1 = stream1.getReader();
      const reader2 = stream2.getReader();

      incoming.handleFrame("stream1", "data1");
      incoming.handleFrame("stream2", "data2");
      incoming.handleFrame("stream1", "data3");
      incoming.handleClose("stream2");
      incoming.handleFrame("stream2", "data4"); // 应该被忽略

      const result1 = await reader1.read();
      const result2 = await reader2.read();
      const result3 = await reader1.read();
      const result4 = await reader2.read();

      expect(result1.value).toBe("data1");
      expect(result2.value).toBe("data2");
      expect(result3.value).toBe("data3");
      expect(result4.done).toBe(true);
      expect(incoming.has("stream1")).toBe(true);
      expect(incoming.has("stream2")).toBe(false);

      incoming.handleClose("stream1");
      expect(incoming.count()).toBe(0);
    });
  });

  describe("Outgoing", () => {
    let outgoing: Outgoing;

    beforeEach(() => {
      outgoing = new Outgoing(sender);
    });

    test("should create a new outgoing stream", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue("data");
          controller.close();
        },
      });

      const id = outgoing.create(stream, {});

      expect(outgoing.has(id)).toBe(true);
      expect(outgoing.count()).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(sender.send).toHaveBeenCalledTimes(2);
      expect(sender.send).toHaveBeenCalledWith(RPCMessage.createStreamFrameEvent(id, "data"));
      expect(sender.send).toHaveBeenCalledWith(RPCMessage.createStreamClosedEvent(id));
      expect(outgoing.has(id)).toBe(false);
    });

    test("should handle multiple data chunks", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue("chunk1");
          controller.enqueue("chunk2");
          controller.close();
        },
      });

      const id = outgoing.create(stream, {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(sender.send).toHaveBeenCalledTimes(3);
      expect(sender.send).toHaveBeenCalledWith(RPCMessage.createStreamFrameEvent(id, "chunk1"));
      expect(sender.send).toHaveBeenCalledWith(RPCMessage.createStreamFrameEvent(id, "chunk2"));
      expect(sender.send).toHaveBeenCalledWith(RPCMessage.createStreamClosedEvent(id));
      expect(outgoing.has(id)).toBe(false);
    });

    test("should handle stream error", async () => {
      const error = new Error("Stream failed");
      const stream = new ReadableStream({
        start(controller) {
          controller.error(error);
        },
      });

      const id = outgoing.create(stream, {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(sender.send).toHaveBeenCalledTimes(1);
      expect(sender.send).toHaveBeenCalledWith(
        RPCMessage.createStreamErrorEvent(id, {
          code: RPCError.Code.Internal,
          message: error.message,
          details: {},
        }),
      );
      expect(outgoing.has(id)).toBe(false);
    });

    test("should handle stream cancellation from remote", async () => {
      const cancelFn = vi.fn();
      const stream = new ReadableStream({
        start() {},
        cancel: cancelFn,
      });

      const id = outgoing.create(stream, {});

      outgoing.handleCancel(id);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(cancelFn).toHaveBeenCalled();
      expect(outgoing.has(id)).toBe(false);
      expect(outgoing.count()).toBe(0);

      expect(sender.send).toHaveBeenCalledTimes(0);
    });

    test("should destroy all streams", async () => {
      const cancelFn1 = vi.fn();
      const stream1 = new ReadableStream({ start() {}, cancel: cancelFn1 });

      const cancelFn2 = vi.fn();
      const stream2 = new ReadableStream({ start() {}, cancel: cancelFn2 });

      outgoing.create(stream1, {});
      outgoing.create(stream2, {});

      expect(outgoing.count()).toBe(2);

      outgoing.destroy(new Error("Connection closed."));

      expect(cancelFn1).toHaveBeenCalled();
      expect(cancelFn2).toHaveBeenCalled();
      expect(outgoing.count()).toBe(0);
    });

    test("should cancel stream when signal is aborted", async () => {
      const abortController = new AbortController();
      const cancelFn = vi.fn();
      const stream = new ReadableStream({
        async start(controller) {
          while (true) {
            try {
              await new Promise((resolve) => setTimeout(resolve, 2));

              controller.enqueue("data");
            } catch {
              break;
            }
          }
        },
        cancel: cancelFn,
      });

      const id = outgoing.create(stream, { signal: abortController.signal });

      await new Promise((resolve) => setTimeout(resolve, 10));

      abortController.abort(RPCError.createCanceled("Request canceled."));

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(cancelFn).toHaveBeenCalled();
      expect(outgoing.has(id)).toBe(false);

      expect(sender.send).toHaveBeenCalledWith(
        RPCMessage.createStreamErrorEvent(id, {
          code: RPCError.Code.Canceled,
          message: "Request canceled.",
          details: {},
        }),
      );
    });

    test("should handle empty stream", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      const id = outgoing.create(stream, {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(sender.send).toHaveBeenCalledTimes(1);
      expect(sender.send).toHaveBeenCalledWith(RPCMessage.createStreamClosedEvent(id));
      expect(outgoing.has(id)).toBe(false);
    });

    test("should handle multiple concurrent streams", async () => {
      const stream1 = new ReadableStream({
        start(controller) {
          controller.enqueue("s1-data1");
          controller.close();
        },
      });
      const stream2 = new ReadableStream({
        start(controller) {
          controller.enqueue("s2-data1");
          controller.enqueue("s2-data2");
          controller.close();
        },
      });

      const id1 = outgoing.create(stream1, {});
      const id2 = outgoing.create(stream2, {});

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(sender.send).toHaveBeenCalledWith(RPCMessage.createStreamFrameEvent(id1, "s1-data1"));
      expect(sender.send).toHaveBeenCalledWith(RPCMessage.createStreamClosedEvent(id1));
      expect(sender.send).toHaveBeenCalledWith(RPCMessage.createStreamFrameEvent(id2, "s2-data1"));
      expect(sender.send).toHaveBeenCalledWith(RPCMessage.createStreamFrameEvent(id2, "s2-data2"));
      expect(sender.send).toHaveBeenCalledWith(RPCMessage.createStreamClosedEvent(id2));
      expect(sender.send).toHaveBeenCalledTimes(5);

      expect(outgoing.count()).toBe(0);
    });

    test("should do nothing when canceling a non-existent stream", () => {
      outgoing.handleCancel("non-existent-id");
      expect(sender.send).not.toHaveBeenCalled();
      expect(outgoing.count()).toBe(0);
    });

    test("should not create stream if signal is already aborted", async () => {
      const abortController = new AbortController();
      const cancelFn = vi.fn();
      const stream = new ReadableStream({ cancel: cancelFn });

      abortController.abort(new Error("Aborted before start"));

      const id = outgoing.create(stream, { signal: abortController.signal });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(cancelFn).toHaveBeenCalled();
      expect(outgoing.has(id)).toBe(false);
      expect(sender.send).toHaveBeenCalledTimes(1);
      expect(sender.send).toHaveBeenCalledWith(
        RPCMessage.createStreamErrorEvent(id, {
          code: RPCError.Code.Aborted,
          message: "Aborted before start",
          details: {},
        }),
      );
    });

    test("should handle destroy with no streams", () => {
      expect(() => outgoing.destroy(new Error("test"))).not.toThrow();
      expect(outgoing.count()).toBe(0);
    });

    test("should handle RPCError during stream processing", async () => {
      const error = RPCError.createInvalidArgument("Invalid argument", { foo: "bar" });
      const stream = new ReadableStream({
        start(controller) {
          controller.error(error);
        },
      });

      const id = outgoing.create(stream, {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(sender.send).toHaveBeenCalledTimes(1);
      expect(sender.send).toHaveBeenCalledWith(
        RPCMessage.createStreamErrorEvent(id, {
          code: error.code,
          message: error.message,
          details: error.details,
        }),
      );
      expect(outgoing.has(id)).toBe(false);
    });

    test("should remove abort listener when stream finishes normally", async () => {
      const abortController = new AbortController();
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      const id = outgoing.create(stream, { signal: abortController.signal });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(outgoing.has(id)).toBe(false);

      abortController.abort();

      expect(sender.send).toHaveBeenCalledTimes(1);
      expect(sender.send).toHaveBeenCalledWith(RPCMessage.createStreamClosedEvent(id));
    });

    test("should remove abort listener when stream errors", async () => {
      const abortController = new AbortController();
      const error = new Error("test error");
      const stream = new ReadableStream({
        start(controller) {
          controller.error(error);
        },
      });

      const id = outgoing.create(stream, { signal: abortController.signal });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(outgoing.has(id)).toBe(false);

      abortController.abort();

      expect(sender.send).toHaveBeenCalledTimes(1);
      expect(sender.send).toHaveBeenCalledWith(
        RPCMessage.createStreamErrorEvent(id, {
          code: RPCError.Code.Internal,
          message: error.message,
          details: {},
        }),
      );
    });

    test("should remove abort listener when stream is cancelled by remote", async () => {
      const abortController = new AbortController();
      const cancelFn = vi.fn();
      const stream = new ReadableStream({ cancel: cancelFn });

      const id = outgoing.create(stream, { signal: abortController.signal });

      expect(outgoing.has(id)).toBe(true);

      outgoing.handleCancel(id);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(cancelFn).toHaveBeenCalled();
      expect(outgoing.has(id)).toBe(false);

      abortController.abort();

      expect(sender.send).not.toHaveBeenCalled();
    });
  });
});
