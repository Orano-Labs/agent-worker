import { createServer, request } from "node:http";
import { AddressInfo, Socket } from "node:net";
import { describe, expect, it } from "vitest";

import { HTTPServer } from "@/internal/http-server";

type Harness = {
  router: HTTPServer.Router;
  port: number;
  close: () => Promise<void>;
};

const createHarness = async (): Promise<Harness> => {
  const server = createServer();
  const router = new HTTPServer.Router(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    router,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

const withHarness = async (callback: (harness: Harness) => Promise<void>) => {
  const harness = await createHarness();

  try {
    await callback(harness);
  } finally {
    await harness.close();
  }
};

const sendRequest = async (port: number, method: string, path: string) => {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path }, (res) => {
      const chunks: Buffer[] = [];

      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
        });
      });
    });

    req.on("error", reject);
    req.end();
  });
};

const sendUpgrade = async (port: number, path: string) => {
  return new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "test",
      },
    });

    req.on("upgrade", (res, socket) => {
      resolve({ status: res.statusCode ?? 0, socket });
    });

    req.on("response", (res) => {
      reject(new Error(`Expected an upgrade, received HTTP ${res.statusCode}`));
    });

    req.on("error", reject);
    req.end();
  });
};

const sendRejectedUpgrade = async (port: number, path: string) => {
  return new Promise<number>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "test",
      },
    });

    req.on("upgrade", () => {
      reject(new Error("Expected the upgrade to be rejected"));
    });

    req.on("response", (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });

    req.on("error", reject);
    req.end();
  });
};

describe("Server.Router", () => {
  it("matches request routes by method and extracts params", async () => {
    await withHarness(async ({ router, port }) => {
      router.request("GET", "/users/:id", ({ res, params }) => {
        res.end(`user:${params.id}`);
      });

      const response = await sendRequest(port, "GET", "/users/42");

      expect(response.status).toBe(200);
      expect(response.body).toBe("user:42");
    });
  });

  it("matches * routes for every method", async () => {
    await withHarness(async ({ router, port }) => {
      router.request("*", "/wildcard", ({ res }) => {
        res.end("matched");
      });

      for (const method of ["GET", "POST", "DELETE", "PATCH"]) {
        const response = await sendRequest(port, method, "/wildcard");

        expect(response.status).toBe(200);
        expect(response.body).toBe("matched");
      }
    });
  });

  it("prefers a method-specific route over a * route", async () => {
    await withHarness(async ({ router, port }) => {
      router.request("*", "/same", ({ res }) => {
        res.end("wildcard");
      });

      router.request("POST", "/same", ({ res }) => {
        res.end("post");
      });

      const wildcard = await sendRequest(port, "GET", "/same");
      const specific = await sendRequest(port, "POST", "/same");

      expect(wildcard.body).toBe("wildcard");
      expect(specific.body).toBe("post");
    });
  });

  it("ignores the query string when matching", async () => {
    await withHarness(async ({ router, port }) => {
      router.request("GET", "/search/:term", ({ res, params }) => {
        res.end(params.term);
      });

      const response = await sendRequest(port, "GET", "/search/rou3?page=2&limit=10");

      expect(response.status).toBe(200);
      expect(response.body).toBe("rou3");
    });
  });

  it("responds 404 when no request route matches", async () => {
    await withHarness(async ({ port }) => {
      const response = await sendRequest(port, "GET", "/missing");

      expect(response.status).toBe(404);
      expect(response.body).toBe("Not Found");
    });
  });

  it("matches upgrade routes and extracts params", async () => {
    await withHarness(async ({ router, port }) => {
      let receivedParams: Record<string, string> | undefined;

      router.upgrade("*", "/tunnel/:id", ({ socket, params, head }) => {
        receivedParams = params;

        expect(Buffer.isBuffer(head)).toBe(true);

        socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n");
      });

      const response = await sendUpgrade(port, "/tunnel/42");

      response.socket.destroy();

      expect(response.status).toBe(101);
      expect(receivedParams).toEqual({ id: "42" });
    });
  });

  it("responds 404 when no upgrade route matches", async () => {
    await withHarness(async ({ port }) => {
      const status = await sendRejectedUpgrade(port, "/missing");

      expect(status).toBe(404);
    });
  });
});
