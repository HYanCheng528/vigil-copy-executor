import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RiskLedger,
  riskLedgerPaths,
  type RiskLedgerSnapshot,
  type RiskCircuitState,
} from "./risk-ledger.js";

export const CLEAR_CONFIRMATION = "I_HAVE_STOPPED_THE_SERVICE_AND_RECONCILED_ALL_NONCES";

type RiskScope = "global" | "ed" | "kuzuo";

interface LedgerSummary {
  utcDate: string;
  circuit: RiskCircuitState;
  unresolvedAttempts: number;
  unknownChargedAttempts: number;
  settledAttempts: number;
}

export interface RiskCliStatus {
  version: 2;
  utcDate: string;
  circuit: RiskCircuitState;
  globalCircuit: RiskCircuitState;
  unresolvedAttempts: number;
  unknownChargedAttempts: number;
  settledAttempts: number;
  ledgers: Record<RiskScope, LedgerSummary>;
}

function summarize(snapshot: RiskLedgerSnapshot): LedgerSummary {
  const attempts = Object.values(snapshot.attempts);
  return {
    utcDate: snapshot.utcDate,
    circuit: snapshot.circuit,
    unresolvedAttempts: attempts
      .filter((attempt) => attempt.state === "reserved" || attempt.state === "unknown_charged").length,
    unknownChargedAttempts: attempts.filter((attempt) => attempt.state === "unknown_charged").length,
    settledAttempts: attempts.filter((attempt) => attempt.state === "settled").length,
  };
}

/**
 * Status and circuit clearing always cover all three independent durability
 * domains derived from the single configured base path. No paths, identities,
 * signers or executor addresses are returned.
 */
export async function runRiskCommand(options: {
  command: "status" | "clear-circuit";
  basePath: string;
  confirmation?: string | undefined;
}): Promise<RiskCliStatus> {
  const paths = riskLedgerPaths(options.basePath);
  const ledgers: Record<RiskScope, RiskLedger> = {
    global: new RiskLedger(paths.global),
    ed: new RiskLedger(paths.ed),
    kuzuo: new RiskLedger(paths.kuzuo),
  };
  try {
    await Promise.all((Object.keys(ledgers) as RiskScope[])
      .map((scope) => ledgers[scope].load({ requireExisting: true })));
    const before = Object.fromEntries((Object.keys(ledgers) as RiskScope[])
      .map((scope) => [scope, summarize(ledgers[scope].snapshot())])) as Record<RiskScope, LedgerSummary>;
    const unresolvedBefore = Object.values(before)
      .reduce((total, summary) => total + summary.unresolvedAttempts, 0);

    if (options.command === "clear-circuit") {
      if (options.confirmation?.trim() !== CLEAR_CONFIRMATION) {
        throw new Error("clear-circuit requires the exact operator reconciliation confirmation");
      }
      if (unresolvedBefore > 0) {
        throw new Error("cannot clear circuit while any global or lane ledger has an unresolved attempt");
      }
      // Establish a durable global maintenance latch before changing either
      // lane. Any partial write failure therefore leaves every broadcast gated.
      await ledgers.global.tripCircuit("operator circuit clear in progress");
      await Promise.all([ledgers.ed.clearCircuit(), ledgers.kuzuo.clearCircuit()]);
      await ledgers.global.clearCircuit();
    }

    const summaries = Object.fromEntries((Object.keys(ledgers) as RiskScope[])
      .map((scope) => [scope, summarize(ledgers[scope].snapshot())])) as Record<RiskScope, LedgerSummary>;
    return {
      version: 2,
      // Compatibility fields retain their old names, but now represent the
      // global circuit plus aggregate attempt counts across all durability files.
      utcDate: summaries.global.utcDate,
      circuit: summaries.global.circuit,
      globalCircuit: summaries.global.circuit,
      unresolvedAttempts: Object.values(summaries)
        .reduce((total, summary) => total + summary.unresolvedAttempts, 0),
      unknownChargedAttempts: Object.values(summaries)
        .reduce((total, summary) => total + summary.unknownChargedAttempts, 0),
      settledAttempts: Object.values(summaries)
        .reduce((total, summary) => total + summary.settledAttempts, 0),
      ledgers: summaries,
    };
  } finally {
    await Promise.allSettled(Object.values(ledgers).map((ledger) => ledger.close()));
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  if (command !== "status" && command !== "clear-circuit") {
    throw new Error("usage: risk-cli status|clear-circuit");
  }
  const basePath = process.env.COPY_EXECUTOR_RISK_LEDGER_PATH?.trim();
  if (!basePath) throw new Error("COPY_EXECUTOR_RISK_LEDGER_PATH is required");
  const status = await runRiskCommand({
    command,
    basePath,
    confirmation: process.env.COPY_EXECUTOR_CLEAR_CIRCUIT_CONFIRM,
  });
  process.stdout.write(JSON.stringify(status) + "\n");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }) + "\n");
    process.exitCode = 1;
  });
}
