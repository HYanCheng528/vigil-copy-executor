import { getAddress, getBytes, hexlify, keccak256, zeroPadValue } from "ethers";
import compiledArtifact from "../contracts/artifacts/GmgnAtomicCopyExecutor.json" with { type: "json" };
// This pins every non-constructor byte to the reviewed solc/optimizer/EVM
// output. The expected deployed runtime is then materialized by replacing
// every named immutable reference with its configured value and compared in
// full; no deployed byte is excluded from the identity check.
export const ATOMIC_EXECUTOR_RUNTIME_LENGTH = 5_800;
export const ATOMIC_EXECUTOR_RUNTIME_TEMPLATE_HASH = "0x4a22738033fc73b28a6bab2082111a610f0fd56d6dab1efc426f5fbd843075b1";
function auditedArtifact() {
    const artifact = compiledArtifact;
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(artifact.deployedBytecode)) {
        throw new Error("atomic executor runtime template is malformed");
    }
    const template = getBytes(artifact.deployedBytecode);
    if (template.length !== ATOMIC_EXECUTOR_RUNTIME_LENGTH
        || keccak256(template) !== ATOMIC_EXECUTOR_RUNTIME_TEMPLATE_HASH) {
        throw new Error("atomic executor runtime template is not the audited release");
    }
    const names = Object.keys(artifact.immutableReferences).sort();
    if (names.length !== 2 || names[0] !== "owner" || names[1] !== "router") {
        throw new Error("atomic executor immutable reference names are invalid");
    }
    const ranges = names.flatMap((name) => (artifact.immutableReferences[name]
        .map((reference) => ({ name: name, ...reference })))).sort((left, right) => left.start - right.start);
    let previousEnd = 0;
    for (const range of ranges) {
        if (!Number.isSafeInteger(range.start) || range.start < previousEnd
            || range.length !== 32 || range.start + range.length > template.length) {
            throw new Error("atomic executor immutable references are malformed or overlapping");
        }
        for (let index = range.start; index < range.start + range.length; index += 1) {
            if (template[index] !== 0)
                throw new Error("atomic executor runtime template immutable is not zero-filled");
        }
        previousEnd = range.start + range.length;
    }
    if (artifact.immutableReferences.owner.length === 0 || artifact.immutableReferences.router.length === 0) {
        throw new Error("atomic executor owner/router immutable references are missing");
    }
    return artifact;
}
const ARTIFACT = auditedArtifact();
export const ATOMIC_EXECUTOR_IMMUTABLE_REFERENCES = Object.freeze({
    owner: Object.freeze(ARTIFACT.immutableReferences.owner.map((reference) => Object.freeze({ ...reference }))),
    router: Object.freeze(ARTIFACT.immutableReferences.router.map((reference) => Object.freeze({ ...reference }))),
});
function immutableWord(address) {
    return getBytes(zeroPadValue(getAddress(address), 32));
}
export function expectedAtomicExecutorRuntime(expectedOwner, expectedRouter) {
    const runtime = getBytes(ARTIFACT.deployedBytecode);
    const words = {
        owner: immutableWord(expectedOwner),
        router: immutableWord(expectedRouter),
    };
    for (const name of ["owner", "router"]) {
        for (const { start } of ARTIFACT.immutableReferences[name])
            runtime.set(words[name], start);
    }
    return hexlify(runtime);
}
export function assertAuditedAtomicExecutorRuntime(code, expectedOwner, expectedRouter) {
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code))
        throw new Error("atomic executor bytecode is malformed");
    const actual = getBytes(code);
    const expected = getBytes(expectedAtomicExecutorRuntime(expectedOwner, expectedRouter));
    if (actual.length !== expected.length) {
        throw new Error("atomic executor bytecode length does not match the audited V2 runtime");
    }
    for (let index = 0; index < expected.length; index += 1) {
        if (actual[index] !== expected[index]) {
            throw new Error("atomic executor bytecode does not exactly match the audited owner/router runtime");
        }
    }
}
//# sourceMappingURL=executor-capability.js.map