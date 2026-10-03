import assert from "node:assert/strict";
import test from "node:test";
import { NonceLane } from "../src/core/nonce-lane.js";

test("first real dispatch optimistically commits N/N+1 so the next lease starts at N+2", () => {
  const target = `0x${"78".repeat(32)}`;
  const nextTarget = `0x${"79".repeat(32)}`;
  const lane = new NonceLane("lane-ed-public");
  lane.synchronize(120);

  const lease = lane.reserve(target, 114_700_001, "1000", 2);
  assert.equal(lease.startNonce, 120);
  assert.equal(lease.span, 2);
  assert.equal(lane.snapshot().nextNonce, 120);

  // All Builders share the buy N + tip N+1 span for this target.
  lane.markSubmitted(target, "club48");
  lane.markSubmitted(target, "blockrazor");
  assert.equal(lane.snapshot().nextNonce, 120);

  const committed = lane.optimisticCommit(target);
  assert.equal(committed.nextNonce, 122);
  assert.equal(committed.state, "ready");
  assert.equal(committed.lease, null);

  const following = lane.reserve(nextTarget, 114_700_002, "1001", 2);
  assert.equal(following.startNonce, 122);
  assert.equal(following.span, 2);
});

test("background nonce refresh cannot overwrite a lease created after the refresh started", () => {
  const target = `0x${"81".repeat(32)}`;
  const lane = new NonceLane("lane-ed-refresh-guard");
  lane.synchronize(40);
  const guard = lane.refreshGuard();

  lane.reserve(target, 114_700_001, "1000", 2);
  const stale = lane.synchronizeIfUnchanged(41, 41, guard);

  assert.equal(stale.applied, false);
  assert.equal(stale.snapshot.state, "reserved");
  assert.equal(stale.snapshot.lease?.startNonce, 40);
});

test("a ready lane accepts a guarded refresh but external pending blocks reuse until reconciliation", () => {
  const lane = new NonceLane("lane-ed-ready-refresh");
  lane.synchronize(40);
  const guarded = lane.synchronizeIfUnchanged(41, 41, lane.refreshGuard());
  assert.equal(guarded.applied, true);
  assert.equal(guarded.snapshot.nextNonce, 41);

  const observed = lane.observeExternalPending(41, `0x${"91".repeat(32)}`);
  assert.equal(observed.state, "external_pending");
  assert.equal(observed.nextNonce, 41, "an unconfirmed external transaction must not advance the reusable nonce");
  assert.equal(lane.synchronizeIfUnchanged(41, 42, guarded.snapshot.generation).applied, false);
});

test("routine nonce authority can advance but never regress or lock an optimistic frontier", () => {
  const target = `0x${"a1".repeat(32)}`;
  const lane = new NonceLane("lane-ed-monotonic-authority");
  lane.synchronize(120);
  lane.reserve(target, 114_700_001, "1000", 2);
  lane.markSubmitted(target, "club48");
  lane.optimisticCommit(target);

  const lagging = lane.advanceIfUnchanged(120, 120, lane.refreshGuard());
  assert.equal(lagging.applied, true);
  assert.equal(lagging.snapshot.state, "ready");
  assert.equal(lagging.snapshot.nextNonce, 122);

  const authorityPendingInsideFrontier = lane.advanceIfUnchanged(121, 122, lane.refreshGuard());
  assert.equal(authorityPendingInsideFrontier.applied, true);
  assert.equal(authorityPendingInsideFrontier.snapshot.state, "ready");
  assert.equal(authorityPendingInsideFrontier.snapshot.nextNonce, 122);

  const forward = lane.advanceIfUnchanged(124, 125, lane.refreshGuard());
  assert.equal(forward.applied, true);
  assert.equal(forward.snapshot.state, "ready");
  assert.equal(forward.snapshot.nextNonce, 125);
});
