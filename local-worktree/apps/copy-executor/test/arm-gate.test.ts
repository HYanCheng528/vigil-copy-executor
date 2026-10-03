import assert from "node:assert/strict";
import test from "node:test";
import { ArmGate } from "../src/arm-gate.js";

test("live arm gate is process-local, exact-confirmation-only, and restart defaults closed", async () => {
  const gate = new ArmGate("/root/unwritable-under-dynamic-user", true);
  await gate.start();
  assert.equal(gate.armed, false);
  await assert.rejects(gate.enable("yes"), /confirmation/);
  await gate.enable(ArmGate.ENABLE_CONFIRMATION);
  assert.equal(gate.armed, true);
  const disabling = gate.disable();
  assert.equal(gate.armed, false, "disable must close synchronously before its Promise resolves");
  await disabling;

  await gate.enable(ArmGate.ENABLE_CONFIRMATION);
  gate.stop();
  assert.equal(gate.armed, false);
  const restarted = new ArmGate(null, true);
  await restarted.start();
  assert.equal(restarted.armed, false, "a process restart must never restore live state");
});

test("non-live modes remain operational but cannot invoke the live control transition", async () => {
  const gate = new ArmGate(null, false);
  await gate.start();
  assert.equal(gate.armed, true);
  await assert.rejects(gate.enable(ArmGate.ENABLE_CONFIRMATION), /outside live mode/);
  gate.stop();
});
