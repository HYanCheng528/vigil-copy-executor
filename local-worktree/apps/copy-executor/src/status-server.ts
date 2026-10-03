import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ExecutorControlError, type CopyExecutionEngine } from "./engine.js";
import type { ConfirmedTargetHint, TargetStrategy } from "./core/messages.js";

const MAX_BODY_BYTES = 2_048;

function isLoopback(remoteAddress: string | undefined): boolean {
  return remoteAddress === "127.0.0.1"
    || remoteAddress === "::1"
    || remoteAddress === "::ffff:127.0.0.1";
}

function json(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  let payload: string;
  try {
    // Engine snapshots can legitimately contain block numbers and other EVM
    // quantities as bigint while a race is active. Native JSON.stringify throws
    // on bigint; encode every bigint as an exact decimal string at this process
    // boundary instead.
    payload = JSON.stringify(body, (_key, value: unknown) => (
      typeof value === "bigint" ? value.toString() : value
    ));
  } catch {
    // A read-only status/control request must never be able to terminate the
    // trading process. Keep this response local and generic if a future
    // snapshot accidentally contains another non-serializable value.
    status = 500;
    payload = '{"error":"serialization_failed"}';
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function jsonSnapshot(
  response: ServerResponse,
  read: () => Record<string, unknown>,
  statusFor: (body: Record<string, unknown>) => number = () => 200,
): void {
  try {
    const body = read();
    json(response, statusFor(body), body);
  } catch {
    // Snapshot collection is a monitoring concern. A broken metric/getter must
    // fail this HTTP request, never escape the callback and restart the live
    // execution process.
    json(response, 500, { error: "snapshot_failed" });
  }
}

function hasBearer(request: IncomingMessage, token: string | null): boolean {
  if (!token) return false;
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer | Uint8Array | string) => {
      if (rejected) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(Object.assign(new Error("request body is too large"), { code: "BODY_TOO_LARGE" }));
        request.resume();
        return;
      }
      chunks.push(bytes);
    });
    request.once("error", reject);
    request.once("end", () => {
      if (rejected) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("body must be an object");
        resolve(value as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function controlError(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed) return;
  if (error instanceof ExecutorControlError) {
    const status = error.code === "mode_forbidden" || error.code === "invalid_confirmation"
      ? 403
      : error.code === "invalid_value"
        ? 422
        : 409;
    json(response, status, { error: error.code });
    return;
  }
  const bodyTooLarge = (error as { code?: unknown } | null)?.code === "BODY_TOO_LARGE";
  json(response, bodyTooLarge ? 413 : 400, { error: bodyTooLarge ? "body_too_large" : "invalid_request" });
}

async function handleControl(
  engine: CopyExecutionEngine,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    json(response, 415, { error: "json_required" });
    request.resume();
    return;
  }
  try {
    const body = await readJsonObject(request);
    if (body.action === "enable" && exactKeys(body, ["action", "confirmation"]) && typeof body.confirmation === "string") {
      await engine.enableLive(body.confirmation);
    } else if (body.action === "disable" && exactKeys(body, ["action"])) {
      // disableLive closes the in-memory broadcast latch synchronously before
      // this handler waits for the arm-file rewrite.
      await engine.disableLive();
    } else if (body.action === "update_lane"
      && exactKeys(body, ["action", "strategy", "followAmountBnb", "gasPriceGwei", "builderTipBnb"])
      && (body.strategy === "ed" || body.strategy === "kuzuo")
      && typeof body.followAmountBnb === "string"
      && typeof body.gasPriceGwei === "string"
      && typeof body.builderTipBnb === "string") {
      await engine.updateRuntimeLane({
        strategy: body.strategy as TargetStrategy,
        followAmountBnb: body.followAmountBnb,
        gasPriceGwei: body.gasPriceGwei,
        builderTipBnb: body.builderTipBnb,
      });
    } else {
      throw new Error("control request schema is invalid");
    }
    json(response, 200, engine.controlSnapshot());
  } catch (error) {
    controlError(response, error);
  }
}

export function startStatusServer(
  engine: CopyExecutionEngine,
  host: string,
  port: number,
  controlBearerToken: string | null = null,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (!isLoopback(request.socket.remoteAddress)) {
      json(response, 403, { error: "forbidden" });
      request.resume();
      return;
    }

    const controlRead = request.url === "/control" || request.url === "/positions";
    const controlPost = request.url === "/internal/control";
    const confirmedPost = request.url === "/internal/confirmed-target";
    if ((controlRead || controlPost || (confirmedPost && controlBearerToken !== null))
      && !hasBearer(request, controlBearerToken)) {
      json(response, 401, { error: "unauthorized" });
      request.resume();
      return;
    }

    if (request.url === "/control" || request.url === "/positions") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        json(response, 405, { error: "method_not_allowed" });
        request.resume();
        return;
      }
      jsonSnapshot(response, () => (
        request.url === "/control" ? engine.controlSnapshot() : engine.positionsSnapshot()
      ));
      return;
    }

    if (request.url === "/internal/control") {
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        json(response, 405, { error: "method_not_allowed" });
        request.resume();
        return;
      }
      void handleControl(engine, request, response);
      return;
    }

    if (request.url === "/internal/confirmed-target") {
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        json(response, 405, { error: "method_not_allowed" });
        request.resume();
        return;
      }
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        json(response, 415, { error: "json_required" });
        request.resume();
        return;
      }
      void readJsonObject(request).then((hint) => {
        const accepted = engine.acceptConfirmedTargetHint(hint as unknown as ConfirmedTargetHint);
        json(response, accepted ? 202 : 409, accepted
          ? { accepted: true }
          : { accepted: false, duplicate: true });
      }).catch((error) => controlError(response, error));
      return;
    }

    if (request.method === "GET" && (request.url === "/health" || request.url === "/status")) {
      jsonSnapshot(
        response,
        () => engine.snapshot(),
        (body) => request.url === "/health" && body.ok !== true ? 503 : 200,
      );
      return;
    }

    json(response, 404, { error: "not_found" });
    request.resume();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
