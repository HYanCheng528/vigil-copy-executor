import assert from "node:assert/strict";
import test from "node:test";
import { PositionRpcReader } from "../src/position-rpc.js";

const TOKEN = "0x0000000000000000000000000000000000007777";
const OWNER = "0x0000000000000000000000000000000000001001";

test("position RPC prefers a public provider and leaves the primary fallback idle", async () => {
  const calls: string[] = [];
  const clients: object[] = [];
  const reader = new PositionRpcReader(
    ["https://public-position.example/"],
    "https://primary-executor.example/",
    1_000,
    2,
    {
      endpointFactory: (url) => {
        const client = {
          tokenBalance: async () => {
            calls.push(url);
            return url.includes("public-position") ? 17n : 99n;
          },
          tokenMetadata: async () => ({ symbol: "AI", decimals: 18 }),
        };
        clients.push(client);
        return { client, close: () => undefined };
      },
    },
  );
  assert.equal(await reader.tokenBalance(TOKEN, OWNER), 17n);
  assert.deepEqual(calls, ["https://public-position.example/"]);
  assert.equal(clients.length, 2);
  assert.notEqual(clients[0], clients[1], "public and primary fallback must be separate clients");
  reader.close();
});

test("position RPC reaches the separately constructed primary only after public failure", async () => {
  const calls: string[] = [];
  const reader = new PositionRpcReader(
    ["https://public-position.example/"],
    "https://primary-executor.example/",
    1_000,
    2,
    {
      endpointFactory: (url) => ({
        client: {
          tokenBalance: async () => {
            calls.push(url);
            if (url.includes("public-position")) throw new Error("public unavailable");
            return 23n;
          },
          tokenMetadata: async () => ({ symbol: null, decimals: null }),
        },
        close: () => undefined,
      }),
    },
  );
  assert.equal(await reader.tokenBalance(TOKEN, OWNER), 23n);
  assert.deepEqual(calls, [
    "https://public-position.example/",
    "https://primary-executor.example/",
  ]);
  reader.close();
});
