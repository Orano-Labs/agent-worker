import { once } from "node:events";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { connect } from "node:net";
import { Container } from "@aw/container";
import { Environment } from "@aw/environment";
import { Logger } from "@aw/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPServer } from "@/internal/http-server";

describe("HTTPServer", () => {
  let http: HTTPServer;
  let server: Server;

  beforeEach(() => {
    const environment = new Environment({ files: false });
    const logger = new Logger();

    http = new HTTPServer(environment, logger);
    server = http.server;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function listen(): Promise<number> {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    return (server.address() as AddressInfo).port;
  }

  function get(port: number, path: string) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  describe("route (request)", () => {
    it("routes a request to the registered handler", async () => {
      http.route({
        kind: "request",
        method: HTTPServer.Method.Get,
        path: "/hello",
        handler: ({ res }) => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("world");
        },
      });

      const port = await listen();
      const response = await get(port, "/hello");

      expect(response.status).toBe(200);
      expect(response.body).toBe("world");
    });

    it("routes by HTTP method", async () => {
      http.route({
        kind: "request",
        method: HTTPServer.Method.Post,
        path: "/only-post",
        handler: ({ res }) => {
          res.writeHead(200);
          res.end("posted");
        },
      });

      const port = await listen();
      const post = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: "/only-post", method: "POST" }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
      });

      expect(post.status).toBe(200);
      expect(post.body).toBe("posted");

      const getResponse = await get(port, "/only-post");
      expect(getResponse.status).toBe(404);
    });

    it("extracts URL params", async () => {
      const handler = vi.fn(({ res, params }) => {
        res.writeHead(200);
        res.end(params.id);
      });

      http.route({
        kind: "request",
        method: HTTPServer.Method.Get,
        path: "/users/:id",
        handler,
      });

      const port = await listen();
      const response = await get(port, "/users/42");

      expect(response.status).toBe(200);
      expect(response.body).toBe("42");
      expect(handler).toHaveBeenCalledOnce();
    });

    it("treats Method.Any as every concrete HTTP method", async () => {
      http.route({
        kind: "request",
        method: HTTPServer.Method.Any,
        path: "/any",
        handler: ({ req, res }) => {
          res.writeHead(200);
          res.end(req.method ?? "unknown");
        },
      });

      const port = await listen();

      for (const method of ["GET", "POST", "DELETE", "PATCH"]) {
        const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = httpRequest({ host: "127.0.0.1", port, path: "/any", method }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          });
          req.on("error", reject);
          req.end();
        });

        expect(response.status).toBe(200);
        expect(response.body).toBe(method);
      }
    });

    it("returns 404 for an unknown request route", async () => {
      const port = await listen();
      const response = await get(port, "/missing");

      expect(response.status).toBe(404);
      expect(response.body).toBe("Request route not found");
    });
  });

  describe("route (upgrade)", () => {
    it("routes an upgrade request to the registered handler", async () => {
      http.route({
        kind: "upgrade",
        method: HTTPServer.Method.Get,
        path: "/upgrade",
        handler: ({ socket }) => {
          socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n");
          socket.end();
        },
      });

      const port = await listen();

      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port }, () => {
          socket.write("GET /upgrade HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n");
        });

        let data = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => (data += chunk));
        socket.once("close", () => resolve(data));
        socket.on("error", reject);
      });

      expect(response).toContain("101 Switching Protocols");
    });

    it("returns a 404 response for an unknown upgrade route", async () => {
      const port = await listen();

      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port }, () => {
          socket.write("GET /missing HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n");
        });

        let data = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => (data += chunk));
        socket.once("close", () => resolve(data));
        socket.on("error", reject);
      });

      expect(response).toContain("404 Not Found");
      expect(response).toContain("Upgrade route not found");
    });
  });

  describe("route conflict detection", () => {
    it("warns when two routes overlap", async () => {
      const warn = vi.spyOn(Logger.prototype, "warn");

      http.route({
        kind: "request",
        method: HTTPServer.Method.Get,
        path: "/overlap",
        handler: () => {},
      });

      http.route({
        kind: "request",
        method: HTTPServer.Method.Get,
        path: "/overlap",
        handler: () => {},
      });

      expect(warn).toHaveBeenCalledWith(
        "Route conflict detected",
        expect.objectContaining({
          method: HTTPServer.Method.Get,
          path: "/overlap",
        }),
      );
    });
  });

  describe("url", () => {
    it("derives the URL from the HTTP_PORT environment variable", () => {
      expect(http.url).toBe("http://127.0.0.1:3008");
    });
  });

  describe("dispose (graceful shutdown)", () => {
    function openSocket(port: number): Promise<Socket> {
      return new Promise<Socket>((resolve, reject) => {
        const socket: Socket = connect({ host: "127.0.0.1", port }, () => resolve(socket));
        socket.on("error", reject);
      });
    }

    it("stops accepting new connections after disposal", async () => {
      const port = await listen();

      await http[Container.SymbolDispose]();

      await expect(
        new Promise((resolve, reject) => {
          const socket = connect({ host: "127.0.0.1", port });
          socket.once("connect", () => resolve(undefined));
          socket.once("error", reject);
        }),
      ).rejects.toThrow();
    });

    it("force-closes lingering connections after the grace period", async () => {
      vi.useFakeTimers();

      const port = await listen();
      const socket = await openSocket(port);
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

      const disposed = http[Container.SymbolDispose]();

      // The connection is still alive within the grace period.
      expect(socket.destroyed).toBe(false);

      await vi.advanceTimersByTimeAsync(HTTPServer.SHUTDOWN_GRACE_MS);

      await expect(disposed).resolves.toBeUndefined();
      await closed;
      expect(socket.destroyed).toBe(true);

      vi.useRealTimers();
    });

    it("completes promptly when there are no open connections", async () => {
      await listen();

      await expect(http[Container.SymbolDispose]()).resolves.toBeUndefined();
    });
  });
});
