import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { createValidateInterceptor } from "@connectrpc/validate";
import { fastify } from "fastify";

const main = async () => {
  const server = fastify({ http2: true, http2SessionTimeout: 1000 * 2 });

  await server.register(fastifyConnectPlugin, {
    interceptors: [createValidateInterceptor()],
    routes: (router) => {},
  });

  await server.listen({ host: "0.0.0.0", port: 8999 });
};

main();
