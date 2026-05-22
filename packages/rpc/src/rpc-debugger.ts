export type RPCDebugger = {
  debug(message: string, context: Record<string, unknown>): void;
};
