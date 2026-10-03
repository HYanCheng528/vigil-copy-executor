import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getAddress, parseEther, parseUnits } from "ethers";
import { DEFAULT_BUILDERS, } from "./builders.js";
import { BLOCKRAZOR_PUBLIC_MEMPOOL_TOKYO_ENDPOINT } from "./blockrazor-public-feed.js";
import { BLOCKRAZOR_PRIVATE_REGIONS } from "./blockrazor-private-feed.js";
import { HotSigner } from "./hot-signer.js";
const LIVE_CONFIRMATION = "I_ACCEPT_AUTOMATED_COPY_TRADING_RISK";
const FULL_PENDING_COST_CONFIRMATION = "I_ACCEPT_UNFILTERED_PENDING_RESPONSE_COST";
const BLOCKRAZOR_PLAINTEXT_CONFIRMATION = "I_ACCEPT_BLOCKRAZOR_PLAINTEXT_API_KEY_TRANSPORT";
const PRIVATE_KEY_PATTERN = /^(?:0x)?[0-9a-fA-F]{64}$/;
const UINT256_MAX = (1n << 256n) - 1n;
const SHADOW_KEYS = {
    ed: "0x1111111111111111111111111111111111111111111111111111111111111111",
    kuzuo: "0x2222222222222222222222222222222222222222222222222222222222222222",
};
function required(env, name) {
    const value = env[name]?.trim();
    if (!value)
        throw new Error(name + " is required");
    return value;
}
function bool(env, name, fallback) {
    const value = env[name]?.trim().toLowerCase();
    if (!value)
        return fallback;
    if (["1", "true", "yes", "on"].includes(value))
        return true;
    if (["0", "false", "no", "off"].includes(value))
        return false;
    throw new Error(name + " must be true or false");
}
function integer(env, name, fallback, min, max) {
    const raw = env[name]?.trim();
    const value = raw ? Number(raw) : fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(name + " must be an integer between " + String(min) + " and " + String(max));
    }
    return value;
}
function bnb(env, name, fallback) {
    const raw = env[name]?.trim() || fallback;
    if (!raw)
        throw new Error(name + " is required");
    try {
        const value = parseEther(raw);
        if (value < 0n || value > UINT256_MAX)
            throw new Error("outside uint256");
        return value;
    }
    catch {
        throw new Error(name + " must be a non-negative BNB amount that fits uint256");
    }
}
function gwei(env, name, fallback) {
    const raw = env[name]?.trim() || fallback;
    try {
        const value = parseUnits(raw, "gwei");
        if (value <= 0n || value > UINT256_MAX)
            throw new Error("outside uint256");
        return value;
    }
    catch {
        throw new Error(name + " must be a positive gwei amount that fits uint256");
    }
}
function optionalAddress(env, name) {
    const raw = env[name]?.trim();
    if (!raw)
        return null;
    try {
        return getAddress(raw);
    }
    catch {
        throw new Error(name + " is not a valid EVM address");
    }
}
function isPathWithin(directory, path) {
    const child = relative(directory, path);
    return child !== ""
        && child !== ".."
        && !child.startsWith(".." + sep)
        && !isAbsolute(child);
}
function pathBelowDirectoryHasSymlink(directory, path) {
    const child = relative(directory, path);
    if (!child || isAbsolute(child) || child === ".." || child.startsWith(".." + sep))
        return true;
    let current = directory;
    for (const component of child.split(sep)) {
        current = resolve(current, component);
        if (lstatSync(current).isSymbolicLink())
            return true;
    }
    return false;
}
/**
 * Read a secret without treating every group-readable file as a systemd
 * credential. `LoadCredential=` exposes an immutable per-unit copy below
 * CREDENTIALS_DIRECTORY; DynamicUser units can see that copy as 0440. That
 * exception is safe only for a real, non-symlink file that resolves inside the
 * manager-provided credential directory and is owned by root or this service.
 * Ordinary files retain the stricter owner-only 0400/0600 policy.
 */
function readSecureSecretFile(path, env, label, minimumSize, maximumSize) {
    const declaredPath = resolve(path);
    const declaredStats = lstatSync(declaredPath);
    if (declaredStats.isSymbolicLink() || !declaredStats.isFile()) {
        throw new Error(label + " path must be a regular non-symlink file");
    }
    let systemdCredential = false;
    const credentialDirectory = env.CREDENTIALS_DIRECTORY?.trim();
    if (credentialDirectory) {
        const declaredDirectory = resolve(credentialDirectory);
        const directoryStats = lstatSync(declaredDirectory);
        if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
            throw new Error("CREDENTIALS_DIRECTORY must be a real directory");
        }
        const realDirectory = realpathSync(declaredDirectory);
        const realPath = realpathSync(declaredPath);
        const lexicallyInside = isPathWithin(declaredDirectory, declaredPath);
        const resolvesInside = isPathWithin(realDirectory, realPath);
        // Require both lexical and resolved containment. The former rejects a
        // path that reaches the mount through an alias; the latter rejects an
        // in-directory symlink escape. The final component was lstat'ed above.
        if (lexicallyInside !== resolvesInside) {
            throw new Error(label + " credential path crosses CREDENTIALS_DIRECTORY through a symlink");
        }
        if (lexicallyInside && pathBelowDirectoryHasSymlink(declaredDirectory, declaredPath)) {
            throw new Error(label + " credential path must not contain symlinks");
        }
        systemdCredential = lexicallyInside && resolvesInside;
    }
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const descriptor = openSync(declaredPath, constants.O_RDONLY | noFollow);
    try {
        const stats = fstatSync(descriptor);
        if (!stats.isFile())
            throw new Error(label + " path must be a regular non-symlink file");
        if (stats.size < minimumSize || stats.size > maximumSize) {
            throw new Error(label + " file size is invalid");
        }
        if (process.platform !== "win32") {
            const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : stats.uid;
            if (stats.uid !== 0 && stats.uid !== effectiveUid) {
                throw new Error(label + " file owner is not trusted");
            }
            const permissions = stats.mode & 0o777;
            if (systemdCredential) {
                const effectiveGid = typeof process.getegid === "function" ? process.getegid() : stats.gid;
                if (permissions !== 0o400 && permissions !== 0o440) {
                    throw new Error(label + " systemd credential must be read-only 0400 or 0440");
                }
                if (permissions === 0o440 && stats.gid !== 0 && stats.gid !== effectiveGid) {
                    throw new Error(label + " systemd credential group is not the service group");
                }
            }
            else if (permissions !== 0o400 && permissions !== 0o600) {
                throw new Error(label + " file must not be readable by group or other users; expected owner-only 0400 or 0600");
            }
        }
        return readFileSync(descriptor, "utf8");
    }
    finally {
        closeSync(descriptor);
    }
}
function readPrivateKeyFile(path, env) {
    const value = readSecureSecretFile(path, env, "private key", 64, 68).trim();
    if (!PRIVATE_KEY_PATTERN.test(value))
        throw new Error("private key file does not contain one 32-byte hex key");
    return value.startsWith("0x") ? value : "0x" + value;
}
function readProviderTokenFile(path, credentialName, env) {
    const value = readSecureSecretFile(path, env, credentialName, 1, 4_096).trim();
    if (!/^[\x21-\x7e]{8,512}$/.test(value)) {
        throw new Error(credentialName + " file must contain 8-512 visible ASCII characters");
    }
    return value;
}
function readControlTokenFile(path, env) {
    const value = readSecureSecretFile(path, env, "executor control token", 32, 512).trim();
    if (!/^[A-Za-z0-9._~-]{32,256}$/.test(value)) {
        throw new Error("executor control token must contain 32-256 bearer-safe ASCII characters");
    }
    return value;
}
function blockRazorPrivateRegions(raw) {
    const values = [...new Set(String(raw ?? "tokyo,new-york,frankfurt,dublin")
            .split(",")
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean))];
    if (values.length === 0)
        throw new Error("BLOCKRAZOR_PRIVATE_MEMPOOL_REGIONS must not be empty");
    for (const value of values) {
        if (!(value in BLOCKRAZOR_PRIVATE_REGIONS)) {
            throw new Error("BLOCKRAZOR_PRIVATE_MEMPOOL_REGIONS contains an unsupported region");
        }
    }
    return values;
}
function loopbackHost(env) {
    const host = env.COPY_EXECUTOR_HOST?.trim().toLowerCase() || "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
        throw new Error("COPY_EXECUTOR_HOST must be a loopback host (127.0.0.1, ::1, or localhost)");
    }
    return host;
}
function wssUrls(raw, name) {
    const values = [...new Set(String(raw ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean))];
    for (const value of values) {
        let parsed;
        try {
            parsed = new URL(value);
        }
        catch {
            throw new Error(name + " contains an invalid URL");
        }
        if (parsed.protocol !== "wss:")
            throw new Error(name + " endpoints must use WSS");
    }
    return values;
}
function httpsUrls(raw, name) {
    const values = [...new Set(String(raw ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean))];
    for (const value of values) {
        let parsed;
        try {
            parsed = new URL(value);
        }
        catch {
            throw new Error(name + " contains an invalid URL");
        }
        if (parsed.protocol !== "https:")
            throw new Error(name + " endpoints must use HTTPS");
    }
    return values;
}
function modeFrom(env) {
    const value = (env.COPY_EXECUTOR_MODE ?? "shadow").trim().toLowerCase();
    if (value === "observe" || value === "shadow" || value === "dry-sign" || value === "live")
        return value;
    throw new Error("COPY_EXECUTOR_MODE must be observe, shadow, dry-sign, or live");
}
function readBuilderAuthFile(path, env) {
    const value = readSecureSecretFile(path, env, "Builder auth", 1, 4_096).trim();
    if (!value || /[^\x20-\x7e\r\n]/.test(value)) {
        throw new Error("Builder auth file must contain visible ASCII provider=value entries");
    }
    return value;
}
function parseBuilderAuth(raw, sourceName) {
    const result = new Map();
    for (const entry of String(raw ?? "").split(/[;,\n]/)) {
        const item = entry.trim();
        if (!item)
            continue;
        const index = item.indexOf("=");
        if (index <= 0)
            throw new Error(sourceName + " entries must use provider=value");
        const name = item.slice(0, index).trim().toLowerCase();
        const value = item.slice(index + 1).trim();
        if (!value)
            throw new Error(sourceName + " contains an empty value");
        result.set(name, value);
    }
    return result;
}
function builderPrewarmInterval(env, name) {
    const specificName = "COPYTRADE_" + name.toUpperCase() + "_PREWARM_INTERVAL_MS";
    if (env[specificName]?.trim()) {
        return integer(env, specificName, DEFAULT_BUILDERS[name].prewarmIntervalMs, 500, 300_000);
    }
    if (env.COPYTRADE_PREWARM_INTERVAL_MS?.trim()) {
        return integer(env, "COPYTRADE_PREWARM_INTERVAL_MS", 15_000, 500, 300_000);
    }
    return DEFAULT_BUILDERS[name].prewarmIntervalMs;
}
function builderConfig(env) {
    const names = (env.COPYTRADE_BUILDERS ?? "club48,jet")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    const unique = [...new Set(names)];
    const inlineAuth = env.COPYTRADE_BUILDER_AUTH?.trim();
    const authFile = env.COPYTRADE_BUILDER_AUTH_FILE?.trim();
    if (inlineAuth) {
        throw new Error("COPYTRADE_BUILDER_AUTH must be empty; use COPYTRADE_BUILDER_AUTH_FILE");
    }
    const auth = authFile
        ? parseBuilderAuth(readBuilderAuthFile(authFile, env), "COPYTRADE_BUILDER_AUTH_FILE")
        : new Map();
    return unique.map((name) => {
        if (name !== "club48" && name !== "blockrazor" && name !== "jet") {
            throw new Error("unsupported Builder " + name);
        }
        const typedName = name;
        const defaults = DEFAULT_BUILDERS[typedName];
        const urlName = "COPYTRADE_" + name.toUpperCase() + "_URL";
        const timeoutName = "COPYTRADE_" + name.toUpperCase() + "_TIMEOUT_MS";
        const config = {
            ...defaults,
            url: env[urlName]?.trim() || defaults.url,
            requestTimeoutMs: integer(env, timeoutName, defaults.requestTimeoutMs, 50, 3_000),
            prewarmIntervalMs: builderPrewarmInterval(env, typedName),
            ...(auth.get(name) ? { authorization: auth.get(name) } : {}),
        };
        return config;
    });
}
function lane(env, mode, strategy) {
    const prefix = strategy === "ed" ? "ED" : "KUZUO";
    const enabled = bool(env, prefix + "_COPY_ENABLED", true);
    const liveLike = mode === "dry-sign" || mode === "live";
    let signer = null;
    if (mode === "shadow") {
        signer = new HotSigner(SHADOW_KEYS[strategy]);
    }
    else if (liveLike && enabled) {
        signer = new HotSigner(readPrivateKeyFile(required(env, prefix + "_COPY_PRIVATE_KEY_FILE"), env));
    }
    const executorAddress = optionalAddress(env, prefix + "_COPY_EXECUTOR_ADDRESS");
    const followAmountWei = bnb(env, prefix + "_FOLLOW_AMOUNT_BNB", liveLike && enabled ? null : "0.01");
    const builderTipWei = bnb(env, prefix + "_BUILDER_TIP_BNB", liveLike && enabled ? null : "0.001");
    if (followAmountWei <= 0n)
        throw new Error(prefix + " follow amount must be positive");
    if (builderTipWei <= 0n)
        throw new Error(prefix + " Builder tip must be positive");
    const gasPriceWei = gwei(env, prefix + "_EXECUTOR_GAS_PRICE_GWEI", "1");
    return {
        strategy,
        label: strategy === "ed" ? "Ed" : "枯坐",
        enabled,
        signer,
        executorAddress,
        followAmountWei,
        builderTipWei,
        gasPriceWei,
        gasLimit: BigInt(integer(env, prefix + "_EXECUTOR_GAS_LIMIT", 1_750_000, 500_000, 3_000_000)),
        edMinReturnRetentionBps: integer(env, "ED_MIN_RETURN_RETENTION_BPS", 10_000, 1, 10_000),
        allowZeroMinReturnInLive: bool(env, "ALLOW_ZERO_MIN_RETURN", false),
    };
}
export function loadConfig(env = process.env) {
    const mode = modeFrom(env);
    const liveConfirmed = env.COPY_EXECUTOR_LIVE_CONFIRM?.trim() === LIVE_CONFIRMATION;
    if (mode === "live" && !liveConfirmed) {
        throw new Error("live mode requires COPY_EXECUTOR_LIVE_CONFIRM=" + LIVE_CONFIRMATION);
    }
    const armFilePath = env.COPY_EXECUTOR_ARM_FILE?.trim() || null;
    if (env.COPY_EXECUTOR_CONTROL_TOKEN?.trim()) {
        throw new Error("COPY_EXECUTOR_CONTROL_TOKEN must be empty; use COPY_EXECUTOR_CONTROL_TOKEN_FILE");
    }
    const controlTokenFile = env.COPY_EXECUTOR_CONTROL_TOKEN_FILE?.trim() || null;
    const controlBearerToken = controlTokenFile ? readControlTokenFile(controlTokenFile, env) : null;
    const runtimeSettingsPath = env.COPY_EXECUTOR_RUNTIME_SETTINGS_PATH?.trim() || null;
    const positionLedgerPath = env.COPY_EXECUTOR_POSITION_LEDGER_PATH?.trim() || null;
    if (mode === "live" && !controlBearerToken) {
        throw new Error("live mode requires COPY_EXECUTOR_CONTROL_TOKEN_FILE");
    }
    if (mode === "live" && !runtimeSettingsPath) {
        throw new Error("live mode requires COPY_EXECUTOR_RUNTIME_SETTINGS_PATH");
    }
    if (mode === "live" && !positionLedgerPath) {
        throw new Error("live mode requires COPY_EXECUTOR_POSITION_LEDGER_PATH");
    }
    const riskLedgerPath = env.COPY_EXECUTOR_RISK_LEDGER_PATH?.trim() || null;
    if ((mode === "dry-sign" || mode === "live") && !riskLedgerPath) {
        throw new Error("dry-sign/live mode requires COPY_EXECUTOR_RISK_LEDGER_PATH");
    }
    const pendingWssUrls = wssUrls(env.BSC_PENDING_WSS_URLS, "BSC_PENDING_WSS_URLS");
    const headWssUrls = wssUrls(env.BSC_HEADS_WSS_URL, "BSC_HEADS_WSS_URL");
    const blockRazorEnabled = bool(env, "BLOCKRAZOR_PUBLIC_MEMPOOL_ENABLED", false);
    const blockRazorPlaintextConfirmed = env.BLOCKRAZOR_PLAINTEXT_GRPC_CONFIRM?.trim()
        === BLOCKRAZOR_PLAINTEXT_CONFIRMATION;
    const blockRazorEndpoint = env.BLOCKRAZOR_PUBLIC_MEMPOOL_ENDPOINT?.trim()
        || BLOCKRAZOR_PUBLIC_MEMPOOL_TOKYO_ENDPOINT;
    if (!/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):[1-9][0-9]{0,4}$/.test(blockRazorEndpoint)) {
        throw new Error("BLOCKRAZOR_PUBLIC_MEMPOOL_ENDPOINT must be host:port without a URL scheme");
    }
    if (blockRazorEnabled && !blockRazorPlaintextConfirmed) {
        throw new Error("BlockRazor Public gRPC sends apiKey over plaintext and requires BLOCKRAZOR_PLAINTEXT_GRPC_CONFIRM="
            + BLOCKRAZOR_PLAINTEXT_CONFIRMATION);
    }
    if (blockRazorEnabled && blockRazorEndpoint !== BLOCKRAZOR_PUBLIC_MEMPOOL_TOKYO_ENDPOINT) {
        throw new Error("enabled BlockRazor Public Mempool is pinned to the official Tokyo endpoint");
    }
    const blockRazorApiKey = blockRazorEnabled
        ? readProviderTokenFile(required(env, "BLOCKRAZOR_PUBLIC_MEMPOOL_API_KEY_FILE"), "BlockRazor Public apiKey", env)
        : null;
    const blockRazorPrivateEnabled = bool(env, "BLOCKRAZOR_PRIVATE_MEMPOOL_ENABLED", false);
    const privateRegions = blockRazorPrivateRegions(env.BLOCKRAZOR_PRIVATE_MEMPOOL_REGIONS);
    const blockRazorPrivateToken = blockRazorPrivateEnabled
        ? readProviderTokenFile(required(env, "BLOCKRAZOR_PRIVATE_MEMPOOL_TOKEN_FILE"), "BlockRazor Private token", env)
        : null;
    if (!blockRazorEnabled && !blockRazorPrivateEnabled && pendingWssUrls.length === 0) {
        throw new Error("BSC_PENDING_WSS_URLS must contain at least one WSS endpoint or a BlockRazor mempool source must be enabled");
    }
    if (pendingWssUrls.length === 0 && headWssUrls.length === 0) {
        throw new Error("BSC_HEADS_WSS_URL is required when full-pending WSS is disabled");
    }
    const fullPendingCostConfirmed = env.BSC_FULL_PENDING_COST_CONFIRM?.trim() === FULL_PENDING_COST_CONFIRMATION;
    if (pendingWssUrls.length > 0 && !fullPendingCostConfirmed) {
        throw new Error("unfiltered BSC full-pending requires BSC_FULL_PENDING_COST_CONFIRM=" + FULL_PENDING_COST_CONFIRMATION);
    }
    const httpRpcUrl = env.BSC_EXECUTOR_HTTP_RPC_URL?.trim() || null;
    if ((mode === "dry-sign" || mode === "live") && !httpRpcUrl) {
        throw new Error("BSC_EXECUTOR_HTTP_RPC_URL is required for nonce and preflight");
    }
    if (httpRpcUrl && new URL(httpRpcUrl).protocol !== "https:") {
        throw new Error("BSC_EXECUTOR_HTTP_RPC_URL must use HTTPS");
    }
    const positionHttpRpcUrls = httpsUrls(env.BSC_POSITION_HTTP_RPC_URLS, "BSC_POSITION_HTTP_RPC_URLS");
    if (mode === "live" && env.COPYTRADE_BUILDERS === undefined) {
        throw new Error("live mode requires an explicit COPYTRADE_BUILDERS capability list");
    }
    const builders = builderConfig(env);
    const publicSourceEnabled = pendingWssUrls.length > 0 || blockRazorEnabled;
    if (mode === "live" && publicSourceEnabled) {
        const names = new Set(builders.map(({ name }) => name));
        if (builders.length !== 3
            || !names.has("club48")
            || !names.has("blockrazor")
            || !names.has("jet")) {
            throw new Error("live public execution requires exactly club48, blockrazor,jet Builder routes");
        }
        if (!builders.find(({ name }) => name === "blockrazor")?.authorization) {
            throw new Error("live public execution requires BlockRazor authorization from COPYTRADE_BUILDER_AUTH_FILE");
        }
    }
    else if (mode === "live" && builders.length === 0 && !blockRazorPrivateEnabled) {
        throw new Error("live mode requires at least one configured Builder submission route");
    }
    const lanes = {
        ed: lane(env, mode, "ed"),
        kuzuo: lane(env, mode, "kuzuo"),
    };
    if ((mode === "dry-sign" || mode === "live") && blockRazorPrivateEnabled) {
        for (const [strategy, configured] of Object.entries(lanes)) {
            if (configured.enabled && !configured.executorAddress) {
                throw new Error(strategy.toUpperCase() + "_COPY_EXECUTOR_ADDRESS is required for BlockRazor Private");
            }
        }
    }
    if (mode === "live" && !lanes.ed.enabled && !lanes.kuzuo.enabled) {
        throw new Error("live mode requires at least one enabled copy-wallet lane");
    }
    return {
        mode,
        liveConfirmed,
        fullPendingCostConfirmed,
        pendingWssUrls,
        headWssUrls,
        headReadyTimeoutMs: integer(env, "BSC_HEAD_READY_TIMEOUT_MS", 5_000, 1_000, 30_000),
        blockRazorPublicMempool: {
            enabled: blockRazorEnabled,
            plaintextTransportConfirmed: blockRazorPlaintextConfirmed,
            name: "blockrazor-public-tokyo",
            endpoint: blockRazorEndpoint,
            apiKey: blockRazorApiKey,
        },
        blockRazorPrivateMempool: {
            enabled: blockRazorPrivateEnabled,
            token: blockRazorPrivateToken,
            regions: privateRegions,
            connectTimeoutMs: integer(env, "BLOCKRAZOR_PRIVATE_CONNECT_TIMEOUT_MS", 5_000, 1_000, 30_000),
            idleTimeoutMs: integer(env, "BLOCKRAZOR_PRIVATE_IDLE_TIMEOUT_MS", 60_000, 5_000, 300_000),
            submitTimeoutMs: integer(env, "BLOCKRAZOR_PRIVATE_SUBMIT_TIMEOUT_MS", 450, 50, 3_000),
            prewarmIntervalMs: blockRazorPrivateEnabled
                ? builderPrewarmInterval(env, "blockrazor")
                : DEFAULT_BUILDERS.blockrazor.prewarmIntervalMs,
        },
        httpRpcUrl,
        positionHttpRpcUrls,
        positionRpcTimeoutMs: integer(env, "COPY_EXECUTOR_POSITION_RPC_TIMEOUT_MS", 1_500, 250, 10_000),
        host: loopbackHost(env),
        port: integer(env, "COPY_EXECUTOR_PORT", 8770, 1, 65_535),
        riskLedgerPath,
        armFilePath,
        controlBearerToken,
        runtimeSettingsPath,
        positionLedgerPath,
        positionReconcileIntervalMs: integer(env, "COPY_EXECUTOR_POSITION_RECONCILE_INTERVAL_MS", 15_000, 5_000, 300_000),
        positionReconcileConcurrency: integer(env, "COPY_EXECUTOR_POSITION_RECONCILE_CONCURRENCY", 4, 1, 16),
        builders,
        lanes,
    };
}
//# sourceMappingURL=config.js.map