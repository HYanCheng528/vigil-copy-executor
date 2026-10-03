import { type RiskCircuitState } from "./risk-ledger.js";
export declare const CLEAR_CONFIRMATION = "I_HAVE_STOPPED_THE_SERVICE_AND_RECONCILED_ALL_NONCES";
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
/**
 * Status and circuit clearing always cover all three independent durability
 * domains derived from the single configured base path. No paths, identities,
 * signers or executor addresses are returned.
 */
export declare function runRiskCommand(options: {
    command: "status" | "clear-circuit";
    basePath: string;
    confirmation?: string | undefined;
}): Promise<RiskCliStatus>;
export {};
