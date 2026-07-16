import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { TunnelClient } from "./tunnel-client";

const BASE = "http://localhost:3008/_debug";
const PROJECT = "test-project";
const TOKEN = "xxxxxxxxxx";
const TARGET = new URL("https://echo.websocket.org/");

const createTunnel = async (project: string, token: string) => {
  const url = `${BASE}/create-tunnel/${project}/${token}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Failed to create tunnel: ${res.status} ${res.statusText}`);
  }
};

(async () => {
  try {
    await createTunnel(PROJECT, TOKEN);
    console.log("Tunnel created");
  } catch (err) {
    console.error("Failed to create tunnel:", err);
  }

  const controller = new AbortController();
  const client = new TunnelClient({
    baseUrl: BASE,
    project: PROJECT,
    token: TOKEN,
    target: TARGET,
    logger: {
      info: (msg, ctx) => console.log("[info]", msg, ctx),
      warn: (msg, ctx) => console.warn("[warn]", msg, ctx),
      error: (msg, ctx) => console.error("[error]", msg, ctx),
      debug: (msg, ctx) => console.log("[debug]", msg, ctx),
    },
    maxSockets: 5,
  });

  client.start(controller.signal);
  console.log("TunnelClient started");

  // Wait for at least one tunnel socket to be established.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // ── SSE ──
  const sseUrl = `${BASE}/link/${PROJECT}/.sse`;

  fetch(sseUrl, { headers: { accept: "text/event-stream" } })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        console.error("SSE connection failed:", res.status);

        return;
      }

      console.log("SSE opened");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          console.log("SSE closed");
          break;
        }

        buf += decoder.decode(value, { stream: true });

        // SSE events are delimited by \n\n.
        const events = buf.split("\n\n");

        buf = events.pop() ?? "";

        for (const event of events) {
          for (const line of event.split("\n")) {
            if (line.startsWith("data: ")) {
              console.log("SSE message:", line.slice(6));
            }
          }
        }
      }
    })
    .catch((err) => console.error("SSE error:", err));

  // ── WebSocket ──
  const wsUrl = `${BASE}/link/${PROJECT}/.ws`.replace("http://", "ws://");
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log("WS connected");
    setInterval(() => {
      ws.send(`hello from tunnel test ${randomBytes(16).toString("hex")}`);
    }, 1000);
  });

  ws.on("message", (data) => console.log("WS message:", data.toString()));
  ws.on("error", (err) => console.error("WS error:", err));
  ws.on("close", (code, reason) => console.log("WS closed:", code, reason?.toString()));

  // Keep process alive.
  process.on("SIGINT", () => {
    console.log("Shutting down…");
    ws.close();
    controller.abort();
  });
})();
