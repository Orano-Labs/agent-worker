import { SmartCoercionPlugin } from "@orpc/json-schema";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { CORSPlugin } from "@orpc/server/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import type { EndpointHelpers } from "@/endpoints/helpers";
import { EXTERNAL_ROUTER } from "@/external-router";
import { Container } from "./helpers/container";
import { HTTPServer } from "./internal/http-server";
import { Logger } from "./internal/logger";

export class ExternalRouterHandler extends OpenAPIHandler<EndpointHelpers.ExternalRouterContext> {
  #logger: Logger;
  #http: HTTPServer;

  constructor() {
    super(EXTERNAL_ROUTER, {
      plugins: [
        new CORSPlugin(),
        new SmartCoercionPlugin({
          schemaConverters: [new ZodToJsonSchemaConverter()],
        }),
      ],
      interceptors: [
        async (options) => {
          this.#logger.info("Request received", {
            url: options.request.url,
            requestId: options.context.connectionId,
            method: options.request.method,
            headers: {
              "content-type": options.request.headers["content-type"],
              "content-length": options.request.headers["content-length"],
              "content-disposition": options.request.headers["content-disposition"],
            },
          });

          let result: Awaited<ReturnType<typeof options.next>>;

          try {
            result = await options.next();
          } catch (error) {
            this.#logger.error("Error occurred during procedure execution", {
              err: error,
              requestId: options.context.connectionId,
            });

            throw error;
          }

          if (result.matched) {
            this.#logger.info("Request handled successfully", {
              requestId: options.context.connectionId,
              status: result.response.status,
            });
          } else {
            this.#logger.warn("No matching procedure found inside handler", { requestId: options.context.connectionId });
          }

          return result;
        },
      ],
    });

    this.#logger = Container.inject(Logger).scope("ExternalRouter");
    this.#http = Container.inject(HTTPServer);
  }

  setup() {
    this.#http.router.get("/api/spec.json", async (_, res) => {
      this.#logger.info("Generating OpenAPI specification");

      try {
        const spec = await new OpenAPIGenerator({
          schemaConverters: [new ZodToJsonSchemaConverter()],
        }).generate(EXTERNAL_ROUTER, {
          info: {
            title: "API SPEC",
            version: "1.0.0",
          },
          servers: [{ url: "/" }],
          security: [{ bearerAuth: [] }],
          components: {},
        });

        this.#logger.info("OpenAPI specification generated successfully");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(spec));
      } catch (error) {
        this.#logger.errorFrom(error, "Failed to generate OpenAPI specification");

        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    });

    this.#http.router.get("/api/scalar", async (_, res) => {
      const configuration = {
        spec: {
          url: "/api/spec.json",
        },
        theme: "solarized",
        showOperationId: true,
      };

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <!doctype html>
        <html>
          <head>
            <title>API Reference</title>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
          </head>
          <body>
            <script id="api-reference" data-configuration='${JSON.stringify(configuration)}'></script>
            <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
          </body>
        </html>
      `);
    });

    this.#http.router.on(["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], "/api/*", async (req, res) => {
      const id = crypto.randomUUID();

      res.setHeader("x-request-id", id);

      try {
        const result = await this.handle(req, res, {
          context: {
            connectionId: id,
          },
        });

        if (!result.matched) {
          res.writeHead(404);
          res.end();
        }
      } catch (error) {
        this.#logger.errorFrom(error, "Fatal error in API router wrapper");

        res.writeHead(500);
        res.end();
      }
    });
  }
}
