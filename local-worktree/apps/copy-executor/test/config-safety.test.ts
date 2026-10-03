import assert from "node:assert/strict";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { CopyExecutionEngine } from "../src/engine.js";
import { PositionRpcReader } from "../src/position-rpc.js";

const LIVE_CONFIRMATION = "I_ACCEPT_AUTOMATED_COPY_TRADING_RISK";
const PENDING_COST_CONFIRMATION = "I_ACCEPT_UNFILTERED_PENDING_RESPONSE_COST";
const BLOCKRAZOR_PLAINTEXT_CONFIRMATION = "I_ACCEPT_BLOCKRAZOR_PLAINTEXT_API_KEY_TRANSPORT";
const KEY_ED = `0x${"41".repeat(32)}`;
const KEY_KUZUO = `0x${"42".repeat(32)}`;

function keyFiles(sameKey = false): { directory: string; ed: string; kuzuo: string; arm: string; control: string; builderAuth: string } {
  const directory = mkdtempSync(join(tmpdir(), "copy-executor-config-"));
  const ed = join(directory, "ed.key");
  const kuzuo = join(directory, "kuzuo.key");
  const arm = join(directory, "armed");
  const control = join(directory, "control.token");
  const builderAuth = join(directory, "builder-auth");
  writeFileSync(ed, `${KEY_ED}\n`, { encoding: "utf8", mode: 0o600 });
  writeFileSync(kuzuo, `${sameKey ? KEY_ED : KEY_KUZUO}\n`, { encoding: "utf8", mode: 0o600 });
  writeFileSync(arm, "DISARMED\n", { encoding: "utf8", mode: 0o600 });
  writeFileSync(control, "test-control-token-0123456789abcdef\n", { encoding: "utf8", mode: 0o600 });
  writeFileSync(builderAuth, "blockrazor=Bearer test-blockrazor-token\n", { encoding: "utf8", mode: 0o600 });
  return { directory, ed, kuzuo, arm, control, builderAuth };
}

function liveLikeEnv(files: ReturnType<typeof keyFiles>, mode: "dry-sign" | "live" = "dry-sign") {
  return {
    COPY_EXECUTOR_MODE: mode,
    COPY_EXECUTOR_RISK_LEDGER_PATH: join(files.directory, "risk-ledger.json"),
    COPY_EXECUTOR_CONTROL_TOKEN_FILE: files.control,
    COPY_EXECUTOR_RUNTIME_SETTINGS_PATH: join(files.directory, "runtime-settings.json"),
    COPY_EXECUTOR_POSITION_LEDGER_PATH: join(files.directory, "positions.json"),
    BSC_PENDING_WSS_URLS: "wss://pending.example/",
    BSC_FULL_PENDING_COST_CONFIRM: PENDING_COST_CONFIRMATION,
    BSC_EXECUTOR_HTTP_RPC_URL: "https://rpc.example/",
    COPYTRADE_BUILDERS: mode === "live" ? "club48,blockrazor,jet" : "club48",
    ...(mode === "live" ? { COPYTRADE_BUILDER_AUTH_FILE: files.builderAuth } : {}),
    ED_COPY_PRIVATE_KEY_FILE: files.ed,
    KUZUO_COPY_PRIVATE_KEY_FILE: files.kuzuo,
    ED_COPY_EXECUTOR_ADDRESS: "0x0000000000000000000000000000000000001001",
    KUZUO_COPY_EXECUTOR_ADDRESS: "0x0000000000000000000000000000000000001002",
    ED_FOLLOW_AMOUNT_BNB: "0.01",
    ED_BUILDER_TIP_BNB: "0.001",
    KUZUO_FOLLOW_AMOUNT_BNB: "0.01",
    KUZUO_BUILDER_TIP_BNB: "0.001",
  };
}

test("live mode has static risk confirmation and a root credential before any key or network setup", () => {
  assert.throws(() => loadConfig({
    COPY_EXECUTOR_MODE: "live",
  }), /COPY_EXECUTOR_LIVE_CONFIRM/);

  assert.throws(() => loadConfig({
    COPY_EXECUTOR_MODE: "live",
    COPY_EXECUTOR_LIVE_CONFIRM: LIVE_CONFIRMATION,
  }), /COPY_EXECUTOR_CONTROL_TOKEN_FILE/);

  const files = keyFiles();
  try {
    const config = loadConfig({
      ...liveLikeEnv(files, "live"),
      COPY_EXECUTOR_LIVE_CONFIRM: LIVE_CONFIRMATION,
      COPY_EXECUTOR_ARM_FILE: files.arm,
    });
    assert.equal(config.mode, "live");
    assert.equal(config.liveConfirmed, true);
    assert.equal(config.armFilePath, files.arm);
    assert.notEqual(config.lanes.ed.signer?.address, config.lanes.kuzuo.signer?.address);
  } finally {
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test("amount, execution gas and Builder tip have no product cap but remain uint256-safe", () => {
  const files = keyFiles();
  const maxBnb = "115792089237316195423570985008687907853269984665640564039457.584007913129639935";
  const maxGwei = "115792089237316195423570985008687907853269984665640564039457584007913.129639935";
  const overflowBnb = "115792089237316195423570985008687907853269984665640564039457.584007913129639936";
  const overflowGwei = "115792089237316195423570985008687907853269984665640564039457584007913.129639936";
  try {
    const base = liveLikeEnv(files);
    const config = loadConfig({
      ...base,
      ED_FOLLOW_AMOUNT_BNB: maxBnb,
      ED_BUILDER_TIP_BNB: maxBnb,
      ED_EXECUTOR_GAS_PRICE_GWEI: maxGwei,
      // Removed legacy ceilings must not silently constrain current values.
      ED_MAX_FOLLOW_AMOUNT_BNB: "0.0001",
      ED_MAX_BUILDER_TIP_BNB: "0.0001",
      ED_MAX_EXECUTOR_GAS_PRICE_GWEI: "0.0001",
    });
    const uint256Max = (1n << 256n) - 1n;
    assert.equal(config.lanes.ed.followAmountWei, uint256Max);
    assert.equal(config.lanes.ed.builderTipWei, uint256Max);
    assert.equal(config.lanes.ed.gasPriceWei, uint256Max);
    assert.equal("maxFollowAmountWei" in config.lanes.ed, false);
    assert.equal("maxBuilderTipWei" in config.lanes.ed, false);
    assert.equal("maxExecutorGasPriceWei" in config.lanes.ed, false);

    assert.throws(() => loadConfig({ ...base, ED_FOLLOW_AMOUNT_BNB: overflowBnb }), /fits uint256/);
    assert.throws(() => loadConfig({ ...base, ED_BUILDER_TIP_BNB: overflowBnb }), /fits uint256/);
    assert.throws(() => loadConfig({ ...base, ED_EXECUTOR_GAS_PRICE_GWEI: overflowGwei }), /fits uint256/);
    assert.throws(() => loadConfig({ ...base, ED_BUILDER_TIP_BNB: "0" }), /Builder tip must be positive/);
  } finally {
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test("dry-sign requires the durable ledger path used to initialize live identity", () => {
  assert.throws(
    () => loadConfig({ COPY_EXECUTOR_MODE: "dry-sign" }),
    /COPY_EXECUTOR_RISK_LEDGER_PATH/,
  );
});

test("live public execution requires all three Builder routes, BlockRazor auth, and an enabled lane", () => {
  const files = keyFiles();
  try {
    const base = {
      ...liveLikeEnv(files, "live"),
      COPY_EXECUTOR_LIVE_CONFIRM: LIVE_CONFIRMATION,
      COPY_EXECUTOR_ARM_FILE: files.arm,
    };
    const implicit = { ...base } as Record<string, string>;
    delete implicit.COPYTRADE_BUILDERS;
    assert.throws(() => loadConfig(implicit), /explicit COPYTRADE_BUILDERS/);
    assert.throws(() => loadConfig({
      ...base,
      COPYTRADE_BUILDERS: "",
    }), /exactly club48, blockrazor,jet Builder routes/);
    assert.throws(() => loadConfig({
      ...base,
      COPYTRADE_BUILDERS: "club48,jet",
    }), /exactly club48, blockrazor,jet Builder routes/);
    assert.throws(() => {
      const noAuth = { ...base } as Record<string, string>;
      delete noAuth.COPYTRADE_BUILDER_AUTH_FILE;
      return loadConfig(noAuth);
    }, /BlockRazor authorization/);
    assert.throws(() => loadConfig({
      ...base,
      ED_COPY_ENABLED: "false",
      KUZUO_COPY_ENABLED: "false",
    }), /at least one enabled copy-wallet lane/);
  } finally {
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test("Ed and kuzuo cannot initialize on the same funded copy wallet", async () => {
  const files = keyFiles(true);
  const engine = new CopyExecutionEngine(loadConfig(liveLikeEnv(files)));
  try {
    await assert.rejects(engine.start(), /must use separate copy wallets/);
  } finally {
    await engine.stop();
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test("Ed and kuzuo cannot initialize against the same atomic executor", async () => {
  const files = keyFiles();
  const env = liveLikeEnv(files);
  env.KUZUO_COPY_EXECUTOR_ADDRESS = env.ED_COPY_EXECUTOR_ADDRESS;
  const engine = new CopyExecutionEngine(loadConfig(env));
  try {
    await assert.rejects(engine.start(), /must use separate atomic executors/);
  } finally {
    await engine.stop();
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test("POSIX live-like key files reject group/other readability", {
  skip: process.platform === "win32" ? "Windows ACLs are outside the POSIX mode-bit gate" : false,
}, () => {
  const files = keyFiles();
  try {
    chmodSync(files.ed, 0o644);
    assert.throws(() => loadConfig(liveLikeEnv(files)), /must not be readable by group or other users/);
    chmodSync(files.ed, 0o600);
    assert.doesNotThrow(() => loadConfig(liveLikeEnv(files)));
  } finally {
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test("systemd LoadCredential accepts read-only 0440 secrets only inside its real credential directory", {
  skip: process.platform === "win32" ? "Windows ACLs are outside the POSIX credential-mode gate" : false,
}, () => {
  const files = keyFiles();
  const credentials = join(files.directory, "systemd-credentials");
  mkdirSync(credentials, { mode: 0o700 });
  const control = join(credentials, "executor-control-token");
  const ed = join(credentials, "ed-copy-key");
  const kuzuo = join(credentials, "kuzuo-copy-key");
  const builderAuth = join(credentials, "builder-auth");
  writeFileSync(control, "systemd-control-token-0123456789abcdef\n", { encoding: "utf8", mode: 0o440 });
  writeFileSync(ed, `${KEY_ED}\n`, { encoding: "utf8", mode: 0o440 });
  writeFileSync(kuzuo, `${KEY_KUZUO}\n`, { encoding: "utf8", mode: 0o440 });
  writeFileSync(builderAuth, "blockrazor=Bearer systemd-builder-token\n", { encoding: "utf8", mode: 0o440 });
  chmodSync(control, 0o440);
  chmodSync(ed, 0o440);
  chmodSync(kuzuo, 0o440);
  chmodSync(builderAuth, 0o440);
  const env = {
    ...liveLikeEnv(files),
    CREDENTIALS_DIRECTORY: credentials,
    COPY_EXECUTOR_CONTROL_TOKEN_FILE: control,
    ED_COPY_PRIVATE_KEY_FILE: ed,
    KUZUO_COPY_PRIVATE_KEY_FILE: kuzuo,
    COPYTRADE_BUILDERS: "blockrazor",
    COPYTRADE_BUILDER_AUTH_FILE: builderAuth,
  };
  try {
    const config = loadConfig(env);
    assert.equal(config.controlBearerToken, "systemd-control-token-0123456789abcdef");
    assert.equal(config.builders[0]?.authorization, "Bearer systemd-builder-token");

    chmodSync(control, 0o640);
    assert.throws(() => loadConfig(env), /systemd credential must be read-only 0400 or 0440/);
    chmodSync(control, 0o440);

    if (typeof process.geteuid === "function" && process.geteuid() === 0) {
      chownSync(control, 12_345, 12_345);
      assert.throws(() => loadConfig(env), /file owner is not trusted/);
      chownSync(control, 0, 0);
    }

    const outside = join(files.directory, "outside-control-token");
    writeFileSync(outside, "outside-control-token-0123456789abcdef\n", { encoding: "utf8", mode: 0o440 });
    chmodSync(outside, 0o440);
    assert.throws(
      () => loadConfig({ ...env, COPY_EXECUTOR_CONTROL_TOKEN_FILE: outside }),
      /must not be readable by group or other users/,
    );

    const linked = join(credentials, "linked-control-token");
    symlinkSync(outside, linked, "file");
    assert.throws(
      () => loadConfig({ ...env, COPY_EXECUTOR_CONTROL_TOKEN_FILE: linked }),
      /regular non-symlink file/,
    );

    const realSubdirectory = join(credentials, "real-subdirectory");
    const linkedSubdirectory = join(credentials, "linked-subdirectory");
    mkdirSync(realSubdirectory, { mode: 0o700 });
    const nestedControl = join(realSubdirectory, "nested-control-token");
    writeFileSync(nestedControl, "nested-control-token-0123456789abcdef\n", { encoding: "utf8", mode: 0o440 });
    chmodSync(nestedControl, 0o440);
    symlinkSync(realSubdirectory, linkedSubdirectory, "dir");
    assert.throws(
      () => loadConfig({
        ...env,
        COPY_EXECUTOR_CONTROL_TOKEN_FILE: join(linkedSubdirectory, "nested-control-token"),
      }),
      /credential path must not contain symlinks/,
    );

    const directory = join(credentials, "not-a-token-file");
    mkdirSync(directory, { mode: 0o700 });
    assert.throws(
      () => loadConfig({ ...env, COPY_EXECUTOR_CONTROL_TOKEN_FILE: directory }),
      /regular non-symlink file/,
    );
  } finally {
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test("pending-feed config requires at least one actual WSS endpoint", () => {
  assert.throws(() => loadConfig({
    COPY_EXECUTOR_MODE: "shadow",
    BSC_PENDING_WSS_URLS: ",",
    BSC_FULL_PENDING_COST_CONFIRM: PENDING_COST_CONFIRMATION,
  }), /must contain at least one .*WSS endpoint/);
});

test("unfiltered full-pending subscription cost is fail-closed without exact confirmation", () => {
  const base = {
    COPY_EXECUTOR_MODE: "shadow",
    BSC_PENDING_WSS_URLS: "wss://pending.example/",
  };
  assert.throws(() => loadConfig(base), /BSC_FULL_PENDING_COST_CONFIRM/);
  assert.throws(
    () => loadConfig({ ...base, BSC_FULL_PENDING_COST_CONFIRM: "yes" }),
    /BSC_FULL_PENDING_COST_CONFIRM/,
  );
  assert.doesNotThrow(() => loadConfig({
    ...base,
    BSC_FULL_PENDING_COST_CONFIRM: PENDING_COST_CONFIRMATION,
  }));
});

test("duplicate full-pending URLs are subscribed only once", () => {
  const url = "wss://pending.example/secret-path";
  const config = loadConfig({
    COPY_EXECUTOR_MODE: "shadow",
    BSC_PENDING_WSS_URLS: `${url},${url}`,
    BSC_FULL_PENDING_COST_CONFIRM: PENDING_COST_CONFIRMATION,
  });
  assert.deepEqual(config.pendingWssUrls, [url]);
});

test("engine isolates fallback heads from full-pending on a second socket", async () => {
  const url = "wss://pending.example/secret-path";
  const engine = new CopyExecutionEngine(loadConfig({
    COPY_EXECUTOR_MODE: "shadow",
    BSC_PENDING_WSS_URLS: url,
    BSC_FULL_PENDING_COST_CONFIRM: PENDING_COST_CONFIRMATION,
  }));
  try {
    const feeds = (engine as unknown as {
      bootstrapFeeds: Array<{ options: {
        name: string;
        url: string;
        subscribePending?: boolean;
        subscribeHeads?: boolean;
      } }>;
    }).bootstrapFeeds.map(({ options }) => ({
      name: options.name,
      url: options.url,
      ...(options.subscribePending === undefined ? {} : { subscribePending: options.subscribePending }),
      ...(options.subscribeHeads === undefined ? {} : { subscribeHeads: options.subscribeHeads }),
    }));
    assert.deepEqual(feeds, [
      {
        name: "heads-1",
        url,
        subscribePending: false,
      },
      {
        name: "pending-1",
        url,
        subscribeHeads: false,
      },
    ]);
  } finally {
    await engine.stop();
  }
});

test("position reconciliation has ordered public RPCs and bounded controls", () => {
  const base = {
    COPY_EXECUTOR_MODE: "shadow",
    BSC_PENDING_WSS_URLS: "wss://pending.example/",
    BSC_FULL_PENDING_COST_CONFIRM: PENDING_COST_CONFIRMATION,
  };
  const config = loadConfig({
    ...base,
    BSC_POSITION_HTTP_RPC_URLS: "https://public-one.example/, https://public-one.example/,https://public-two.example/",
    COPY_EXECUTOR_POSITION_RPC_TIMEOUT_MS: "777",
    COPY_EXECUTOR_POSITION_RECONCILE_CONCURRENCY: "3",
  });
  assert.deepEqual(config.positionHttpRpcUrls, [
    "https://public-one.example/",
    "https://public-two.example/",
  ]);
  assert.equal(config.positionRpcTimeoutMs, 777);
  assert.equal(config.positionReconcileConcurrency, 3);
  assert.throws(() => loadConfig({
    ...base,
    BSC_POSITION_HTTP_RPC_URLS: "http://not-private.example/",
  }), /BSC_POSITION_HTTP_RPC_URLS endpoints must use HTTPS/);
  assert.throws(() => loadConfig({
    ...base,
    COPY_EXECUTOR_POSITION_RECONCILE_CONCURRENCY: "17",
  }), /COPY_EXECUTOR_POSITION_RECONCILE_CONCURRENCY/);
});

test("engine position reads cannot reuse the execution RPC client or its provider object", async () => {
  const engine = new CopyExecutionEngine(loadConfig({
    COPY_EXECUTOR_MODE: "shadow",
    BSC_PENDING_WSS_URLS: "wss://pending.example/",
    BSC_FULL_PENDING_COST_CONFIRM: PENDING_COST_CONFIRMATION,
    BSC_EXECUTOR_HTTP_RPC_URL: "https://primary-executor.example/",
    BSC_POSITION_HTTP_RPC_URLS: "https://public-position.example/",
    COPY_EXECUTOR_POSITION_LEDGER_PATH: "memory",
  }));
  try {
    const internals = engine as unknown as {
      rpc: unknown;
      positionLedger: { reader: unknown };
    };
    assert.ok(internals.positionLedger.reader instanceof PositionRpcReader);
    assert.notEqual(internals.positionLedger.reader, internals.rpc);
    const endpoints = internals.positionLedger.reader as unknown as {
      endpoints: Array<{ client: unknown }>;
    };
    assert.equal(endpoints.endpoints.length, 2);
    assert.notEqual(endpoints.endpoints[1]?.client, internals.rpc,
      "even the primary fallback must own a separate RPC client/Agent");
  } finally {
    await engine.stop();
  }
});

test("Builder heartbeat idle targets use provider defaults and per-Builder overrides win", () => {
  const base = {
    COPY_EXECUTOR_MODE: "shadow",
    BSC_PENDING_WSS_URLS: "wss://pending.example/",
    BSC_FULL_PENDING_COST_CONFIRM: PENDING_COST_CONFIRMATION,
    COPYTRADE_BUILDERS: "club48,blockrazor,jet",
  };
  const defaults = loadConfig(base);
  assert.deepEqual(defaults.builders.map(({ name, prewarmIntervalMs }) => [name, prewarmIntervalMs]), [
    ["club48", 30_000],
    ["blockrazor", 45_000],
    ["jet", 15_000],
  ]);

  const overridden = loadConfig({
    ...base,
    COPYTRADE_PREWARM_INTERVAL_MS: "22000",
    COPYTRADE_JET_PREWARM_INTERVAL_MS: "7000",
  });
  assert.deepEqual(overridden.builders.map(({ name, prewarmIntervalMs }) => [name, prewarmIntervalMs]), [
    ["club48", 22_000],
    ["blockrazor", 22_000],
    ["jet", 7_000],
  ]);

  const blankSpecific = loadConfig({
    ...base,
    COPYTRADE_PREWARM_INTERVAL_MS: "22000",
    COPYTRADE_JET_PREWARM_INTERVAL_MS: "   ",
  });
  assert.equal(blankSpecific.builders.find(({ name }) => name === "jet")?.prewarmIntervalMs, 22_000);

  for (const invalid of ["not-a-number", "499", "300001"]) {
    assert.throws(() => loadConfig({
      ...base,
      COPYTRADE_JET_PREWARM_INTERVAL_MS: invalid,
    }), /COPYTRADE_JET_PREWARM_INTERVAL_MS must be an integer/);
  }

  const specificsIgnoreInvalidLegacyFallback = loadConfig({
    ...base,
    COPYTRADE_PREWARM_INTERVAL_MS: "invalid-unused-fallback",
    COPYTRADE_CLUB48_PREWARM_INTERVAL_MS: "30000",
    COPYTRADE_BLOCKRAZOR_PREWARM_INTERVAL_MS: "15000",
    COPYTRADE_JET_PREWARM_INTERVAL_MS: "15000",
  });
  assert.equal(specificsIgnoreInvalidLegacyFallback.builders.length, 3);
  assert.throws(() => loadConfig({
    ...base,
    COPYTRADE_PREWARM_INTERVAL_MS: "invalid-used-fallback",
    COPYTRADE_CLUB48_PREWARM_INTERVAL_MS: "30000",
    COPYTRADE_BLOCKRAZOR_PREWARM_INTERVAL_MS: "15000",
  }), /COPYTRADE_PREWARM_INTERVAL_MS must be an integer/);
});

test("default public Builder capability omits unauthenticated BlockRazor", () => {
  const config = loadConfig({
    COPY_EXECUTOR_MODE: "shadow",
    BSC_PENDING_WSS_URLS: "wss://pending.example/",
    BSC_FULL_PENDING_COST_CONFIRM: PENDING_COST_CONFIRMATION,
  });
  assert.deepEqual(config.builders.map(({ name }) => name), ["club48", "jet"]);
});

test("status listener is fail-closed to loopback hosts", () => {
  const base = {
    COPY_EXECUTOR_MODE: "shadow",
    BSC_PENDING_WSS_URLS: "wss://pending.example/",
    BSC_FULL_PENDING_COST_CONFIRM: PENDING_COST_CONFIRMATION,
  };
  for (const host of ["127.0.0.1", "::1", "localhost"]) {
    assert.equal(loadConfig({ ...base, COPY_EXECUTOR_HOST: host }).host, host);
  }
  for (const host of ["0.0.0.0", "::", "10.0.0.8", "status.example"]) {
    assert.throws(() => loadConfig({ ...base, COPY_EXECUTOR_HOST: host }), /loopback host/);
  }
});

test("BlockRazor Public plaintext apiKey transport needs an exact gate and official Tokyo pin", () => {
  const files = keyFiles();
  const token = join(files.directory, "blockrazor-public.token");
  writeFileSync(token, "dedicated-rotatable-token\n", { encoding: "utf8", mode: 0o600 });
  const base = {
    COPY_EXECUTOR_MODE: "shadow",
    BLOCKRAZOR_PUBLIC_MEMPOOL_ENABLED: "true",
    BLOCKRAZOR_PUBLIC_MEMPOOL_API_KEY_FILE: token,
    BSC_HEADS_WSS_URL: "wss://heads.example/",
  };
  try {
    assert.throws(() => loadConfig(base), /BLOCKRAZOR_PLAINTEXT_GRPC_CONFIRM/);
    const config = loadConfig({
      ...base,
      BLOCKRAZOR_PLAINTEXT_GRPC_CONFIRM: BLOCKRAZOR_PLAINTEXT_CONFIRMATION,
    });
    assert.equal(config.blockRazorPublicMempool.plaintextTransportConfirmed, true);
    assert.throws(() => loadConfig({
      ...base,
      BLOCKRAZOR_PLAINTEXT_GRPC_CONFIRM: BLOCKRAZOR_PLAINTEXT_CONFIRMATION,
      BLOCKRAZOR_PUBLIC_MEMPOOL_ENDPOINT: "example.test:50051",
    }), /official Tokyo endpoint/);
  } finally {
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test("BlockRazor Private source reads one root-only token and selects fixed official regions", () => {
  const files = keyFiles();
  const token = join(files.directory, "blockrazor-private.token");
  writeFileSync(token, "private-dedicated-token\n", { encoding: "utf8", mode: 0o600 });
  try {
    assert.throws(() => loadConfig({
      COPY_EXECUTOR_MODE: "shadow",
      BLOCKRAZOR_PRIVATE_MEMPOOL_ENABLED: "true",
      BSC_HEADS_WSS_URL: "wss://heads.example/",
    }), /BLOCKRAZOR_PRIVATE_MEMPOOL_TOKEN_FILE/);
    const config = loadConfig({
      COPY_EXECUTOR_MODE: "shadow",
      BLOCKRAZOR_PRIVATE_MEMPOOL_ENABLED: "true",
      BLOCKRAZOR_PRIVATE_MEMPOOL_TOKEN_FILE: token,
      BLOCKRAZOR_PRIVATE_MEMPOOL_REGIONS: "tokyo,dublin,tokyo",
      BSC_HEADS_WSS_URL: "wss://heads.example/",
    });
    assert.equal(config.blockRazorPrivateMempool.enabled, true);
    assert.deepEqual(config.blockRazorPrivateMempool.regions, ["tokyo", "dublin"]);
    assert.equal(config.pendingWssUrls.length, 0);
    assert.throws(() => loadConfig({
      COPY_EXECUTOR_MODE: "shadow",
      BLOCKRAZOR_PRIVATE_MEMPOOL_ENABLED: "true",
      BLOCKRAZOR_PRIVATE_MEMPOOL_TOKEN_FILE: token,
      BLOCKRAZOR_PRIVATE_MEMPOOL_REGIONS: "tokyo,moon",
      BSC_HEADS_WSS_URL: "wss://heads.example/",
    }), /unsupported region/);
  } finally {
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test("Builder authorization can come only from one root-only credential file", () => {
  const files = keyFiles();
  const authFile = join(files.directory, "builder-auth");
  const credential = "blockrazor=Bearer dedicated-builder-token";
  writeFileSync(authFile, credential + "\n", { encoding: "utf8", mode: 0o600 });
  const base = {
    COPY_EXECUTOR_MODE: "shadow",
    BSC_PENDING_WSS_URLS: "wss://pending.example/",
    BSC_FULL_PENDING_COST_CONFIRM: PENDING_COST_CONFIRMATION,
    COPYTRADE_BUILDERS: "blockrazor",
  };
  try {
    const config = loadConfig({ ...base, COPYTRADE_BUILDER_AUTH_FILE: authFile });
    assert.equal(config.builders[0]?.authorization, "Bearer dedicated-builder-token");
    assert.throws(() => loadConfig({
      ...base,
      COPYTRADE_BUILDER_AUTH: "blockrazor=inline-secret",
    }), /must be empty.*COPYTRADE_BUILDER_AUTH_FILE/);
    assert.throws(() => loadConfig({
      ...base,
      COPYTRADE_BUILDER_AUTH: "blockrazor=inline-secret",
      COPYTRADE_BUILDER_AUTH_FILE: authFile,
    }), /must be empty.*COPYTRADE_BUILDER_AUTH_FILE/);
    writeFileSync(authFile, "not-a-provider-entry\n", { encoding: "utf8", mode: 0o600 });
    assert.throws(
      () => loadConfig({ ...base, COPYTRADE_BUILDER_AUTH_FILE: authFile }),
      /provider=value/,
    );
    if (process.platform !== "win32") {
      writeFileSync(authFile, credential + "\n", { encoding: "utf8", mode: 0o644 });
      chmodSync(authFile, 0o644);
      assert.throws(
        () => loadConfig({ ...base, COPYTRADE_BUILDER_AUTH_FILE: authFile }),
        /must not be readable by group or other users/,
      );
    }
  } finally {
    rmSync(files.directory, { recursive: true, force: true });
  }
});
