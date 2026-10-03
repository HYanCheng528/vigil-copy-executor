export declare const ATOMIC_EXECUTOR_RUNTIME_LENGTH = 5800;
export declare const ATOMIC_EXECUTOR_RUNTIME_TEMPLATE_HASH = "0x4a22738033fc73b28a6bab2082111a610f0fd56d6dab1efc426f5fbd843075b1";
export declare const ATOMIC_EXECUTOR_IMMUTABLE_REFERENCES: Readonly<{
    owner: readonly Readonly<{
        start: number;
        length: number;
    }>[];
    router: readonly Readonly<{
        start: number;
        length: number;
    }>[];
}>;
export declare function expectedAtomicExecutorRuntime(expectedOwner: string, expectedRouter: string): string;
export declare function assertAuditedAtomicExecutorRuntime(code: string, expectedOwner: string, expectedRouter: string): void;
