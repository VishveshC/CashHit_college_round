import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import solc from "solc";

const root = process.cwd();
const sources = {};
function addSources(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const name = path.posix.join(directory, item.name);
    if (item.isDirectory()) addSources(name);
    else if (item.isFile() && item.name.endsWith(".sol")) sources[name] = { content: readFileSync(name, "utf8") };
  }
}
addSources("contracts/src");
const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

function findImports(specifier) {
  const importPath = path.resolve(root, "node_modules", specifier);
  const nodeModules = path.resolve(root, "node_modules") + path.sep;
  if (!importPath.startsWith(nodeModules)) {
    return { error: `Import outside node_modules is not allowed: ${specifier}` };
  }
  try {
    return { contents: readFileSync(importPath, "utf8") };
  } catch {
    return { error: `Could not resolve import: ${specifier}` };
  }
}

const version = solc.version();
if (!version.startsWith("0.8.36+")) {
  throw new Error(`Expected pinned solc 0.8.36, got ${version}`);
}

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const diagnostics = output.errors ?? [];
for (const diagnostic of diagnostics) {
  const write = diagnostic.severity === "error" ? console.error : console.warn;
  write(diagnostic.formattedMessage.trimEnd());
}

const errors = diagnostics.filter(({ severity }) => severity === "error");
if (errors.length > 0) process.exit(1);

const sourceCount = Object.keys(output.sources ?? {}).length;
const contracts = Object.values(output.contracts ?? {}).flatMap(Object.values);
console.log(`solc ${version}`);
console.log(`Compile succeeded: ${sourceCount} source units, ${contracts.length} compiled contract/library artifacts, 0 errors.`);
const escrow = output.contracts?.["contracts/src/FairworkEscrow.sol"]?.FairworkEscrow;
if (escrow) {
  mkdirSync("packages/chain/generated", { recursive: true });
  writeFileSync("packages/chain/generated/FairworkEscrow.json", JSON.stringify({ contractName: "FairworkEscrow", compiler: version, localChainId: 31337, abi: escrow.abi }, null, 2) + "\n");
  console.log("Generated local escrow ABI; no address or deployment is implied.");
}

for (const [source, name] of [["contracts/src/FairworkArbitration.sol", "FairworkArbitration"], ["contracts/src/mocks/MockRandomness.sol", "MockRandomness"]]) {
  const artifact = output.contracts?.[source]?.[name];
  if (!artifact) continue;
  mkdirSync("packages/chain/generated", { recursive: true });
  writeFileSync(`packages/chain/generated/${name}.json`, JSON.stringify({ contractName: name, compiler: version, localChainId: 31337, abi: artifact.abi }, null, 2) + "\n");
  console.log(`Generated local ${name} ABI; no address or deployment is implied.`);
}
