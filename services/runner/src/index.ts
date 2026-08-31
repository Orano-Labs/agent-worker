import { readFileSync } from "node:fs";
import { Server as HTTPServer } from "node:http";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { spawn } from "@lydell/node-pty";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { type WebSocket, Server as WSServer } from "ws";
import { z } from "zod/v4";

const PORT = 8000;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

const DEFAULT_TIMEOUT = 60 * 2;

const Command = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("data"),
    data: z.string(),
  }),
  z.object({
    type: z.literal("resize"),
    rows: z.int(),
    cols: z.int(),
  }),
]);

const main = async () => {
  const { values, positionals } = parseArgs({
    options: {
      command: {
        type: "string",
        short: "c",
        default: "/bin/sh",
      },
      cwd: {
        type: "string",
        short: "w",
        default: process.cwd(),
      },
      env: {
        type: "string",
        short: "e",
        multiple: true,
      },
      timeout: {
        type: "string",
        short: "t",
        default: "0",
      },
    },
    allowPositionals: true,
  });

  const cwd = resolve(process.cwd(), values.cwd || ".");
  const timeout = Math.max(0, parseInt(values.timeout || "0", 10));
  const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout * 1000 : DEFAULT_TIMEOUT * 1000;
  const env: Record<string, string | undefined> = { ...process.env };

  if (values.env) {
    for (const item of values.env) {
      const eqIndex = item.indexOf("=");

      if (eqIndex > 0) {
        const key = item.slice(0, eqIndex);
        const val = item.slice(eqIndex + 1);

        env[key] = val;
      }
    }
  }

  let connection: WebSocket | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;

  const resetTimeout = () => {
    if (timeoutMs <= 0) return;

    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }

    timeoutTimer = setTimeout(() => {
      console.warn(`[Timeout] No activity for ${values.timeout}s. Terminating PTY...`);

      try {
        pty.kill();
      } catch {}
    }, timeoutMs);
  };

  resetTimeout();

  const http = new HTTPServer();
  const ws = new WSServer({ noServer: true });
  const serlizer = new SerializeAddon();
  const term = new Terminal({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS, allowProposedApi: true, scrollback: 1000 * 3 });

  term.loadAddon(serlizer);

  const pty = spawn(values.command, positionals, {
    name: "xterm-256color",
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    cwd,
    env,
  });

  pty.onData((data) => {
    term.write(data);

    if (connection && connection.readyState === connection.OPEN) {
      connection.send(data);
    }

    resetTimeout();
  });

  pty.onExit(({ exitCode }) => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }

    for (const client of ws.clients) {
      client.close();
    }

    http.close();
    process.exit(exitCode ?? 0);
  });

  ws.on("connection", (client) => {
    if (connection && connection.readyState === 1) {
      return client.close(4429, "Only one WebSocket connection allowed");
    }

    connection?.close();

    connection = client;

    client.send(serlizer.serialize());

    client.on("message", (buffer) => {
      if (connection !== client) {
        return;
      }

      let command: unknown;

      try {
        command = JSON.parse(buffer.toString());
      } catch {}

      const parsed = Command.safeParse(command);

      if (!parsed.success) {
        return;
      }

      if (parsed.data.type === "data") {
        pty.write(parsed.data.data);
      } else {
        pty.resize(parsed.data.cols, parsed.data.rows);
        term.resize(parsed.data.cols, parsed.data.rows);
      }
    });

    client.on("close", () => {
      if (connection === client) {
        connection = null;
      }
    });
  });

  let index: string;

  try {
    index = readFileSync(resolve(__dirname, "index.html"), "utf-8");
  } catch {}

  http.on("request", (_, res) => {
    if (index) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(index);
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Terminal Service</title>
            <style>
              :root { color-scheme: dark; }
              body {
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                background-color: #121212;
                color: #e0e0e0;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
              }
              .card {
                background: #1e1e1e;
                border: 1px solid #333;
                border-radius: 8px;
                padding: 24px 32px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
              }
              code {
                background: #2d2d2d;
                color: #4af626;
                padding: 2px 6px;
                border-radius: 4px;
              }
            </style>
          </head>
          <body>
            <div class="card">
              <p>No <code>index.html</code> provided.</p>
              <p>Connect via WebSocket at <code>/ws</code> to interact with the Terminal.</p>
            </div>
          </body>
          </html>
        `.trim(),
      );
    }
  });

  http.on("upgrade", (req, socket, head) => {
    if (connection && connection.readyState === 1) {
      const body = "Only one WebSocket connection is allowed at a time.";

      try {
        socket.write(
          `HTTP/1.1 429 Too Many Requests\r\n` +
            `Content-Type: text/plain\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            `Connection: close\r\n` +
            `\r\n` +
            body,
        );
      } catch {}

      socket.destroy();

      return;
    }

    ws.handleUpgrade(req, socket, head, (client, req) => {
      ws.emit("connection", client, req);
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.listen(PORT, () => {
      resolve();
    });

    http.once("error", (error) => {
      reject(error);
    });
  });
};

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
