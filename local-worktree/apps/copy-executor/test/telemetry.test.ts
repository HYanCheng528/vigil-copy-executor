import assert from "node:assert/strict";
import test from "node:test";
import { serializeTelemetryRecord, type TelemetryRecord } from "../src/telemetry.js";

test("telemetry serializes nested bigint fields as exact decimal strings", () => {
  const line = serializeTelemetryRecord({
    type: "builder_ack_fixture",
    at: "2026-08-09T06:17:00.000Z",
    lastAck: { startedMonoNs: 1n, responseMonoNs: 2n },
  });
  assert.deepEqual(JSON.parse(line), {
    type: "builder_ack_fixture",
    at: "2026-08-09T06:17:00.000Z",
    lastAck: { startedMonoNs: "1", responseMonoNs: "2" },
  });
});

test("an unserializable telemetry record degrades locally instead of throwing", () => {
  const record: TelemetryRecord = {
    type: "circular_fixture",
    at: "2026-08-09T06:17:00.000Z",
  };
  record.self = record;
  assert.doesNotThrow(() => serializeTelemetryRecord(record));
  assert.equal(JSON.parse(serializeTelemetryRecord(record)).type, "telemetry_serialization_failed");
});
