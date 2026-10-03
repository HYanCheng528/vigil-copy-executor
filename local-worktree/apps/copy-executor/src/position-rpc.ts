import { Agent, request as httpsRequest } from "node:https";
import { ExecutorRpcClient } from "./rpc-client.js";
import type { PositionReader } from "./position-ledger.js";

const MAX_RESPONSE_BYTES = 1_048_576;

interface PositionRpcEndpoint {
  client: Pick<ExecutorRpcClient, "tokenBalance" | "tokenMetadata">;
  close(): void;
}

export interface PositionRpcReaderDependencies {
  endpointFactory?: (url: string, timeoutMs: number, permits: RpcPermitPool) => PositionRpcEndpoint;
}

/** A single cap shared by every preferred and fallback HTTP endpoint. */
export class RpcPermitPool {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("position RPC concurrency must be positive");
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

function isolatedFetch(agent: Agent, permits: RpcPermitPool): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => permits.run(async () => {
    const target = typeof input === "string" || input instanceof URL ? new URL(input) : new URL(input.url);
    if (target.protocol !== "https:") throw new Error("position RPC must use HTTPS");
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      throw new Error("position RPC request body is invalid");
    }
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    if (typeof body === "string" && headers["content-length"] === undefined) {
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    return new Promise<Response>((resolve, reject) => {
      const options = {
        method: init?.method ?? "GET",
        headers,
        agent,
        ...(init?.signal ? { signal: init.signal } : {}),
      };
      const request = httpsRequest(target, options, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += value.length;
          if (length > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("position RPC response is too large"));
            return;
          }
          chunks.push(value);
        });
        response.once("error", reject);
        response.once("end", () => {
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500 }));
        });
      });
      request.once("error", reject);
      request.end(body);
    });
  })) as typeof fetch;
}

function defaultEndpointFactory(url: string, timeoutMs: number, permits: RpcPermitPool): PositionRpcEndpoint {
  // This Agent is intentionally never shared with the latency-critical
  // ExecutorRpcClient. Even when `url` is the primary QuickNode fallback,
  // position traffic owns different sockets, queues and connection failures.
  const agent = new Agent({
    keepAlive: true,
    maxSockets: permits.limit,
    maxFreeSockets: permits.limit,
    scheduling: "lifo",
  });
  return {
    client: new ExecutorRpcClient(url, timeoutMs, isolatedFetch(agent, permits)),
    close: () => agent.destroy(),
  };
}

export class PositionRpcReader implements PositionReader {
  private readonly endpoints: PositionRpcEndpoint[];
  private closed = false;

  constructor(
    preferredUrls: readonly string[],
    fallbackUrl: string | null,
    timeoutMs: number,
    concurrency: number,
    dependencies: PositionRpcReaderDependencies = {},
  ) {
    const urls = [...new Set([
      ...preferredUrls,
      ...(fallbackUrl ? [fallbackUrl] : []),
    ])];
    if (urls.length === 0) throw new Error("position RPC needs at least one endpoint");
    for (const url of urls) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("position RPC contains an invalid URL");
      }
      if (parsed.protocol !== "https:") throw new Error("position RPC endpoints must use HTTPS");
    }
    const permits = new RpcPermitPool(concurrency);
    const factory = dependencies.endpointFactory ?? defaultEndpointFactory;
    this.endpoints = urls.map((url) => factory(url, timeoutMs, permits));
  }

  async tokenBalance(token: string, owner: string): Promise<bigint> {
    return this.firstAvailable((endpoint) => endpoint.client.tokenBalance(token, owner));
  }

  async tokenMetadata(token: string): Promise<{ symbol: string | null; decimals: number | null }> {
    return this.firstAvailable((endpoint) => endpoint.client.tokenMetadata(token));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const endpoint of this.endpoints) endpoint.close();
  }

  private async firstAvailable<T>(read: (endpoint: PositionRpcEndpoint) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("position RPC reader is closed");
    for (const endpoint of this.endpoints) {
      try {
        return await read(endpoint);
      } catch {
        // A public read failure falls through to the next public endpoint and
        // finally the separately-pooled primary executor RPC, if configured.
      }
    }
    throw new Error("all position RPC providers failed");
  }
}
