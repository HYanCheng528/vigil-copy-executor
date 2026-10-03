import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import solc from "solc";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");

export const CONTRACT_NAME = "GmgnAtomicCopyExecutor";
export const SOURCE_NAME = `contracts/${CONTRACT_NAME}.sol`;
export const EVM_VERSION = "paris";

export function compileContract() {
  const sourcePath = resolve(PACKAGE_DIRECTORY, SOURCE_NAME);
  const input = {
    language: "Solidity",
    sources: {
      [SOURCE_NAME]: {
        content: readFileSync(sourcePath, "utf8"),
      },
    },
    settings: {
      evmVersion: EVM_VERSION,
      optimizer: {
        enabled: true,
        runs: 200,
      },
      metadata: {
        bytecodeHash: "ipfs",
      },
      outputSelection: {
        "*": {
          "": ["ast"],
          "*": [
            "abi",
            "metadata",
            "evm.bytecode.object",
            "evm.bytecode.linkReferences",
            "evm.deployedBytecode.object",
            "evm.deployedBytecode.immutableReferences",
            "evm.methodIdentifiers",
          ],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const diagnostics = output.errors ?? [];
  const errors = diagnostics.filter(({ severity }) => severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join("\n"));
  }

  const compiled = output.contracts?.[SOURCE_NAME]?.[CONTRACT_NAME];
  if (!compiled) {
    throw new Error(`solc did not produce ${SOURCE_NAME}:${CONTRACT_NAME}`);
  }
  const sourceAst = output.sources?.[SOURCE_NAME]?.ast;
  if (!sourceAst) {
    throw new Error(`solc did not produce the AST for ${SOURCE_NAME}`);
  }

  return {
    compiled,
    sourceAst,
    diagnostics,
    compilerVersion: solc.version(),
    input,
  };
}

function immutableDeclarationsById(sourceAst) {
  const declarations = new Map();
  const contract = sourceAst.nodes?.find((node) => (
    node?.nodeType === "ContractDefinition" && node.name === CONTRACT_NAME
  ));
  if (!contract) throw new Error(`AST does not contain contract ${CONTRACT_NAME}`);
  for (const node of contract.nodes ?? []) {
    if (node?.nodeType !== "VariableDeclaration" || node.stateVariable !== true
      || node.mutability !== "immutable") continue;
    if (!Number.isSafeInteger(node.id) || typeof node.name !== "string" || node.name.length === 0
      || node.visibility !== "public" || node.typeDescriptions?.typeString !== "address") {
      throw new Error("atomic Executor immutable declarations must be named public addresses");
    }
    declarations.set(String(node.id), node.name);
  }
  return declarations;
}

export function namedImmutableReferences(compiled, sourceAst) {
  const declarations = immutableDeclarationsById(sourceAst);
  const rawReferences = compiled.evm.deployedBytecode.immutableReferences ?? {};
  const declarationNames = [...declarations.values()].sort();
  if (JSON.stringify(declarationNames) !== JSON.stringify(["owner", "router"])) {
    throw new Error("atomic Executor immutable declarations must be exactly owner, router");
  }
  if (Object.keys(rawReferences).length !== declarations.size) {
    throw new Error("runtime immutable reference ids do not cover every immutable declaration");
  }
  const named = {};
  for (const [id, references] of Object.entries(rawReferences)) {
    const name = declarations.get(id);
    if (!name) throw new Error(`immutable AST id ${id} has no named state-variable declaration`);
    if (named[name]) throw new Error(`immutable state variable ${name} appears under multiple AST ids`);
    named[name] = references.map(({ start, length }) => ({ start, length }));
  }
  const actualNames = Object.keys(named).sort();
  const expectedNames = ["owner", "router"];
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`atomic Executor immutables must be exactly ${expectedNames.join(", ")}`);
  }

  const runtimeLength = compiled.evm.deployedBytecode.object.length / 2;
  const runtimeTemplate = Buffer.from(compiled.evm.deployedBytecode.object, "hex");
  const ranges = Object.entries(named).flatMap(([name, references]) => (
    references.map(({ start, length }) => ({ name, start, length }))
  )).sort((left, right) => left.start - right.start);
  let previousEnd = 0;
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.length)
      || range.start < previousEnd || range.length !== 32
      || range.start + range.length > runtimeLength) {
      throw new Error(`immutable reference for ${range.name} is malformed or overlapping`);
    }
    if (!runtimeTemplate.subarray(range.start, range.start + range.length).every((value) => value === 0)) {
      throw new Error(`immutable reference template for ${range.name} is not zero-filled`);
    }
    previousEnd = range.start + range.length;
  }
  if (named.owner.length === 0 || named.router.length === 0) {
    throw new Error("owner and router must each have at least one runtime reference");
  }
  return named;
}

export function buildArtifact() {
  const { compiled, sourceAst, diagnostics, compilerVersion } = compileContract();
  return {
    contractName: CONTRACT_NAME,
    sourceName: SOURCE_NAME,
    compilerVersion,
    evmVersion: EVM_VERSION,
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`,
    deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
    immutableReferences: namedImmutableReferences(compiled, sourceAst),
    methodIdentifiers: compiled.evm.methodIdentifiers,
    warnings: diagnostics
      .filter(({ severity }) => severity === "warning")
      .map(({ formattedMessage }) => formattedMessage),
  };
}

export function writeArtifact() {
  const artifact = buildArtifact();
  const artifactDirectory = resolve(PACKAGE_DIRECTORY, "contracts", "artifacts");
  const artifactPath = resolve(artifactDirectory, `${CONTRACT_NAME}.json`);
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return { artifact, artifactPath };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  const { artifact, artifactPath } = writeArtifact();
  process.stdout.write(
    `${artifact.contractName} compiled with ${artifact.compilerVersion} (${artifact.evmVersion})\n${artifactPath}\n`,
  );
}
