import {createHash} from 'node:crypto';
import {copyFile, lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const artifactTestPrefix = 'fairwork-phase4-artifact-test-';

export const productionExcludedPaths = Object.freeze([
  'apps/web/app/api/dev',
  'apps/web/app/api/* except the explicit read-only config fixture',
  'apps/web/lib/dev-wallet.ts',
  'apps/web/lib/dev-controls.ts',
  'apps/web/lib/dev-control-runtime.ts',
  'apps/web/lib/local-rpc.ts',
  'apps/web/lib/chain-server.ts',
  'apps/web/lib/server',
  'apps/web/test',
  'apps/web/prisma',
  'apps/web/.next and all generated build directories',
  'all node_modules directories (dependency resolver only is junctioned read-only)',
  'all .env* files, databases, runtime backups and private-key files',
  'infra/local and local runtime files',
  'packages/chain/generated/MockRandomness.json',
]);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const assertOnce = (source, expression, label, replacement = '') => {
  const matches = source.match(expression) ?? [];
  if (matches.length !== 1) throw new Error(`Expected exactly one ${label} in staged chain source; found ${matches.length}.`);
  return source.replace(expression, replacement);
};

/**
 * Shared production exclusion transform: MockRandomness is a local demo adapter,
 * so remove its import and public ABI exports from any staged production source.
 * This operates only on a staging copy and refuses source drift instead of
 * silently emitting a partially transformed artifact.
 */
export function transformProductionChainSource(source) {
  let result = source;
  result = assertOnce(result, /^import randomnessJSON from ['"][^'\"]*MockRandomness\.json['"] with \{type:'json'\};\r?\n/m, 'MockRandomness import');
  result = assertOnce(result, /^export const escrowAbi:any=escrowJSON\.abi, arbitrationAbi:any=engineJSON\.abi, randomnessAbi:any=randomnessJSON\.abi;\r?\n/m,
    'ABI export declaration', 'export const escrowAbi:any=escrowJSON.abi, arbitrationAbi:any=engineJSON.abi;\n');
  result = assertOnce(result, /^export const abis=\{escrow:escrowAbi,arbitration:arbitrationAbi,randomness:randomnessAbi\};\r?\n/m,
    'ABI map export', 'export const abis={escrow:escrowAbi,arbitration:arbitrationAbi};\n');
  return result;
}

function transformArtifactTestChainSource(source) {
  let result = transformProductionChainSource(source);
  result = assertOnce(result, /^import \{verifyDeployment\} from '\.\/chain-pins\.ts';\r?\n/m, 'local deployment pin import');
  result = result.replace(/await verifyDeployment\(config,pc\);/g, '');
  if (result.includes('verifyDeployment(')) throw new Error('A deployment pin call survived the artifact-test source transform.');
  result = assertOnce(result, /^export const localChain=defineChain\(\{id:31337,name:'Fairwork local',nativeCurrency:\{name:'Demo Ether',symbol:'ETH',decimals:18\},rpcUrls:\{default:\{http:\['http:\/\/127\.0\.0\.1:8545'\]\}\}\}\);\r?\n/m,
    'local chain descriptor', "export const localChain=defineChain({id:0,name:'Non-deployable artifact-test fixture',nativeCurrency:{name:'Fixture',symbol:'FIX',decimals:18},rpcUrls:{default:{http:[]}}});\n");
  result = assertOnce(result, /^export function publicClient\(config:PublicConfig\)\{if\(config\.chainId!==31337\|\|config\.rpcUrl!=='http:\/\/127\.0\.0\.1:8545'\)throw new Error\('Unsupported local chain configuration'\);return createPublicClient\(\{chain:localChain,transport:http\(config\.rpcUrl\),pollingInterval:100\}\);\}\r?\n/m,
    'local-only public client', "export function publicClient(config:PublicConfig){const fixtureChain=defineChain({id:config.chainId,name:'Non-deployable artifact-test fixture',nativeCurrency:{name:'Fixture',symbol:'FIX',decimals:18},rpcUrls:{default:{http:[config.rpcUrl]}}});return createPublicClient({chain:fixtureChain,transport:http(config.rpcUrl),pollingInterval:100});}\n");
  return result;
}

async function copyRequired(sourceRoot, stageRoot, relativePath) {
  const from = path.join(sourceRoot, relativePath);
  const to = path.join(stageRoot, relativePath);
  const info = await lstat(from);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular source file: ${relativePath}`);
  await mkdir(path.dirname(to), {recursive: true});
  await copyFile(from, to);
  const bytes = await readFile(to);
  return {path: relativePath, bytes: bytes.length, sha256: sha256(bytes)};
}

async function copyClientSources(sourceRoot, stageRoot) {
  const from = path.join(sourceRoot, 'apps/web/lib/client');
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
        const relativePath = path.relative(sourceRoot, absolute);
        files.push(await copyRequired(sourceRoot, stageRoot, relativePath));
      }
    }
  };
  await visit(from);
  return files;
}

async function copyAllExcept(sourceRoot, stageRoot, sourceRelative) {
  const sourceDirectory = path.join(sourceRoot, sourceRelative);
  const files = [];
  const ignoredDirectoryNames = new Set(['node_modules', '.next', '.git', 'test', 'tests', 'prisma', 'coverage', 'runtime']);
  const ignoredFile = (name) => /^(?:\.env(?:\..*)?|.*\.(?:sqlite|sqlite3|db|key|pem))$/i.test(name)
    || /(?:private.?key|test.?key|mockrandomness)/i.test(name);
  const visit = async (directory) => {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || ignoredFile(entry.name)) continue;
      if (entry.isDirectory()) {
        if (ignoredDirectoryNames.has(entry.name) || entry.name.startsWith('.next')) continue;
        await visit(absolute);
      } else if (entry.isFile()) {
        const relativePath = path.relative(sourceRoot, absolute);
        const normalized = relativePath.replaceAll('\\', '/');
        if (normalized.startsWith('apps/web/app/api/dev/')) continue;
        if (normalized === 'apps/web/lib/dev-wallet.ts'
          || normalized === 'apps/web/lib/dev-controls.ts'
          || normalized === 'apps/web/lib/dev-control-runtime.ts'
          || normalized === 'apps/web/lib/local-rpc.ts'
          || normalized === 'apps/web/lib/chain-server.ts') continue;
        if (normalized === 'packages/chain/generated/MockRandomness.json') continue;
        if (normalized === 'apps/web/lib/chain.ts') {
          const staged = transformProductionChainSource(await readFile(absolute, 'utf8'));
          const destination = path.join(stageRoot, relativePath);
          await mkdir(path.dirname(destination), {recursive: true});
          await writeFile(destination, staged, 'utf8');
          files.push({path: relativePath, bytes: Buffer.byteLength(staged), sha256: sha256(staged)});
        } else {
          files.push(await copyRequired(sourceRoot, stageRoot, relativePath));
        }
      }
    }
  };
  await visit(sourceDirectory);
  return files;
}

function artifactNextConfig() {
  return `import type {NextConfig} from 'next';\n\nconst config:NextConfig={\n  distDir:'.next-artifact-test',\n  poweredByHeader:false,\n  allowedDevOrigins:[],\n  async headers(){return [{source:'/:path*',headers:[\n    {key:'Content-Security-Policy',value:"default-src 'none'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"},\n    {key:'X-Content-Type-Options',value:'nosniff'},\n    {key:'X-Frame-Options',value:'DENY'},\n    {key:'Referrer-Policy',value:'no-referrer'},\n    {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=()'}\n  ]}];}\n};\nexport default config;\n`;
}

const readOnlyConfigRoute = `export const dynamic = 'force-dynamic';\n\n// Explicitly non-deployable fixture: no addresses, credentials, RPC endpoints, or write handlers.\nexport async function GET() {\n  return Response.json({ error: 'NON_DEPLOYABLE_ARTIFACT_TEST_CONFIG_UNAVAILABLE' }, {\n    status: 503,\n    headers: { 'Cache-Control': 'no-store' },\n  });\n}\n`;
const devWalletTypeResolutionStub = `// Synthetic type-resolution stub for the isolated artifact test only.\nexport function createDemoProvider(_config: unknown, _role: unknown): never {\n  throw new Error('Unavailable in the non-deployable artifact-test fixture.');\n}\n`;

async function writeArtifactTestShell(sourceRoot, stageRoot) {
  const files = [];
  for (const relativePath of [
    'apps/web/app/page.tsx',
    'apps/web/app/layout.tsx',
    'apps/web/app/globals.css',
    'apps/web/components/EscrowDashboard.tsx',
    'apps/web/components/ArbiterRegistry.tsx',
    'apps/web/tsconfig.json',
  ]) files.push(await copyRequired(sourceRoot, stageRoot, relativePath));
  files.push(...await copyClientSources(sourceRoot, stageRoot));
  // The registry client performs the original deployment-pin check before
  // reading chain state. Preserve that verifier; never replace it with a stub.
  files.push(await copyRequired(sourceRoot, stageRoot, 'apps/web/lib/chain-pins.ts'));

  const chainPath = path.join(sourceRoot, 'apps/web/lib/chain.ts');
  const stagedChain = transformArtifactTestChainSource(await readFile(chainPath, 'utf8'));
  const stagedChainPath = path.join(stageRoot, 'apps/web/lib/chain.ts');
  await mkdir(path.dirname(stagedChainPath), {recursive: true});
  await writeFile(stagedChainPath, stagedChain, 'utf8');
  files.push({path: 'apps/web/lib/chain.ts', bytes: Buffer.byteLength(stagedChain), sha256: sha256(stagedChain)});

  // Next's type checker resolves even a dead dynamic import before optimization.
  // This keyless stub exists only in the temp stage; the chunk scan must prove
  // the local role branch and this module are absent from emitted output.
  const walletStubPath = path.join(stageRoot, 'apps/web/lib/dev-wallet.ts');
  await mkdir(path.dirname(walletStubPath), {recursive: true});
  await writeFile(walletStubPath, devWalletTypeResolutionStub, 'utf8');
  files.push({path: 'apps/web/lib/dev-wallet.ts (synthetic type-resolution stub)', bytes: Buffer.byteLength(devWalletTypeResolutionStub), sha256: sha256(devWalletTypeResolutionStub)});

  for (const relativePath of [
    'packages/chain/generated/FairworkEscrow.json',
    'packages/chain/generated/FairworkArbitration.json',
  ]) files.push(await copyRequired(sourceRoot, stageRoot, relativePath));

  const appRoot = path.join(stageRoot, 'apps/web');
  const apiConfigPath = path.join(appRoot, 'app/api/config/route.ts');
  await mkdir(path.dirname(apiConfigPath), {recursive: true});
  await writeFile(apiConfigPath, readOnlyConfigRoute, 'utf8');
  files.push({path: 'apps/web/app/api/config/route.ts (fixture)', bytes: Buffer.byteLength(readOnlyConfigRoute), sha256: sha256(readOnlyConfigRoute)});

  const nextConfig = artifactNextConfig();
  await writeFile(path.join(appRoot, 'next.config.ts'), nextConfig, 'utf8');
  files.push({path: 'apps/web/next.config.ts (fixture)', bytes: Buffer.byteLength(nextConfig), sha256: sha256(nextConfig)});

  const packageJson = JSON.stringify({name: 'fairwork-nondeployable-artifact-test', private: true, type: 'module'}, null, 2) + '\n';
  await writeFile(path.join(appRoot, 'package.json'), packageJson, 'utf8');
  const envTypes = '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n';
  await writeFile(path.join(appRoot, 'next-env.d.ts'), envTypes, 'utf8');
  const appNodeModules = path.join(stageRoot, 'node_modules');
  await symlink(path.join(sourceRoot, 'node_modules'), appNodeModules, 'junction');
  return {files, appRoot, outputRoot: path.join(appRoot, '.next-artifact-test')};
}

export async function createArtifactTestStage(sourceRoot) {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const stageRoot = await mkdtemp(path.join(os.tmpdir(), artifactTestPrefix));
  try {
    const shell = await writeArtifactTestShell(resolvedSourceRoot, stageRoot);
    return {
      stageRoot,
      appRoot: shell.appRoot,
      outputRoot: shell.outputRoot,
      stagedFiles: shell.files,
      excludedSourcePaths: [...productionExcludedPaths],
      outputDirectoryIsOutsideWorkspace: !shell.outputRoot.toLowerCase().startsWith(resolvedSourceRoot.toLowerCase() + path.sep),
    };
  } catch (error) {
    await removeArtifactTestStage(stageRoot);
    throw error;
  }
}

/**
 * Common source boundary used by the packaging fixture and the future approved
 * public wrapper. Public staging requires an approval contract object; the
 * current wrapper never has one, so the current public target remains blocked.
 */
export async function createProductionExclusionStage({sourceRoot, target, approvedPublicInputs}) {
  if (target === 'artifact-test') return createArtifactTestStage(sourceRoot);
  if (target !== 'public') throw new Error(`Unsupported staged build target: ${target}`);
  if (approvedPublicInputs?.approvalStatus !== 'approved'
    || typeof approvedPublicInputs?.adapterContractPath !== 'string'
    || typeof approvedPublicInputs?.publicConfigPath !== 'string') {
    throw new Error('Public artifact staging requires an approved production adapter contract and public config.');
  }
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const stageRoot = await mkdtemp(path.join(os.tmpdir(), artifactTestPrefix));
  try {
    const files = [];
    files.push(...await copyAllExcept(resolvedSourceRoot, stageRoot, 'apps/web'));
    files.push(...await copyAllExcept(resolvedSourceRoot, stageRoot, 'packages/chain/generated'));
    const stageApp = path.join(stageRoot, 'apps/web');
    await symlink(path.join(resolvedSourceRoot, 'node_modules'), path.join(stageRoot, 'node_modules'), 'junction');
    return {
      stageRoot,
      appRoot: stageApp,
      outputRoot: path.join(stageApp, '.next'),
      stagedFiles: files,
      excludedSourcePaths: [...productionExcludedPaths],
      outputDirectoryIsOutsideWorkspace: !stageApp.toLowerCase().startsWith(resolvedSourceRoot.toLowerCase() + path.sep),
      mode: 'public-pending-approved-adapter',
    };
  } catch (error) {
    await removeArtifactTestStage(stageRoot);
    throw error;
  }
}

export function isArtifactTestStagePath(stageRoot) {
  const resolved = path.resolve(stageRoot);
  const temporaryRoot = path.resolve(os.tmpdir());
  return path.basename(resolved).startsWith(artifactTestPrefix)
    && resolved.toLowerCase().startsWith(temporaryRoot.toLowerCase() + path.sep);
}

export async function removeArtifactTestStage(stageRoot) {
  if (!isArtifactTestStagePath(stageRoot)) throw new Error('Refusing to remove a path outside the isolated artifact-test temp directory.');
  const absolute = path.resolve(stageRoot);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Refusing to remove a non-directory or linked artifact-test stage.');
  const {rm} = await import('node:fs/promises');
  await rm(absolute, {recursive: true, force: false});
}

/**
 * Read the excluded dev-wallet source for an exact known local key list. The
 * current module only relays requests to an unlocked local RPC and contains no
 * key literals, so an empty result is explicitly not a key-absence proof. Any
 * found literals stay in memory and are never staged or written to a report.
 */
export async function readKnownTestPrivateKeys(sourceRoot) {
  const sourcePath = path.join(path.resolve(sourceRoot), 'apps/web/lib/dev-wallet.ts');
  const source = await readFile(sourcePath, 'utf8');
  return [...new Set([...source.matchAll(/\b0x[0-9a-f]{64}\b/gi)].map((match) => match[0].toLowerCase()))];
}

export async function scanArtifactTestOutput(outputRoot, {knownTestPrivateKeys = []} = {}) {
  const outputFiles = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) outputFiles.push(absolute);
    }
  };
  await visit(outputRoot);

  const textualFiles = outputFiles.filter((file) => /\.(?:js|json|html|txt|nft\.json|mjs|cjs)$/i.test(file));
  let routeManifest = null;
  const routeManifestFile = path.join(outputRoot, 'server/app-paths-manifest.json');
  try { routeManifest = JSON.parse(await readFile(routeManifestFile, 'utf8')); } catch {}
  const apiPaths = routeManifest ? Object.keys(routeManifest).filter((route) => route.startsWith('/api/')).sort() : [];
  const routeSource = path.join(outputRoot, 'server/app/api/config/route.js');
  let routeSourceText = '';
  try { routeSourceText = await readFile(routeSource, 'utf8'); } catch {}
  const matches = {
    devApi: 0,
    mockRandomness: 0,
    demoControls: 0,
    knownTestPrivateKeys: 0,
    localRpcOrOrigin: 0,
    localOnlyChainUx: 0,
  };
  const markerMatchers = {
    devApi: /\/api\/dev(?:\/|\\)/gi,
    mockRandomness: /MockRandomness|randomnessAbi|Synchronous deterministic fulfillment|Fulfill mock randomness/gi,
    demoControls: /Development accounts only|Choose a seeded role|createDemoProvider|dev-wallet|LOCAL TESTING ONLY|Advance chain clock|Development controls/gi,
    localRpcOrOrigin: /(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::\d+)?/gi,
    localOnlyChainUx: /(?:Fairwork Local|Switch to 31337|local chain 31337|0x7a69)/gi,
  };
  const foundFiles = Object.fromEntries(Object.keys(markerMatchers).map((key) => [key, []]));
  for (const file of textualFiles) {
    const text = await readFile(file, 'utf8');
    for (const [key, matcher] of Object.entries(markerMatchers)) {
      matcher.lastIndex = 0;
      const found = text.match(matcher) ?? [];
      if (found.length) {
        matches[key] += found.length;
        if (!foundFiles[key].includes(path.relative(outputRoot, file).replaceAll('\\', '/'))) {
          foundFiles[key].push(path.relative(outputRoot, file).replaceAll('\\', '/'));
        }
      }
    }
    const normalizedText = text.toLowerCase();
    for (const key of knownTestPrivateKeys) {
      const normalizedKey = key.toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(normalizedKey)) continue;
      let offset = 0;
      let count = 0;
      while ((offset = normalizedText.indexOf(normalizedKey, offset)) !== -1) {
        count += 1;
        offset += normalizedKey.length;
      }
      if (count) {
        matches.knownTestPrivateKeys += count;
        const relative = path.relative(outputRoot, file).replaceAll('\\', '/');
        if (!foundFiles.knownTestPrivateKeys.includes(relative)) foundFiles.knownTestPrivateKeys.push(relative);
      }
    }
  }
  const onlyFixtureConfigRoute = apiPaths.length === 1 && apiPaths[0] === '/api/config/route';
  const fixtureHasOnlyGetHandler = routeSourceText.includes('NON_DEPLOYABLE_ARTIFACT_TEST_CONFIG_UNAVAILABLE')
    && /\bGET\s*:\s*\(\s*\)\s*=>/.test(routeSourceText)
    && !/\b(?:POST|PUT|PATCH|DELETE)\s*:\s*\(\s*\)\s*=>/.test(routeSourceText);
  const artifact = {
    outputFileCount: outputFiles.length,
    textualChunkAndManifestCount: textualFiles.length,
    routeManifestFound: routeManifest !== null,
    apiRoutes: apiPaths,
    routeManifestsContainDevApi: apiPaths.some((route) => route.startsWith('/api/dev')) || matches.devApi > 0,
    chunksContainMockRandomness: matches.mockRandomness > 0,
    chunksContainSeededDemoControls: matches.demoControls > 0,
    knownTestPrivateKeyScanComplete: knownTestPrivateKeys.length > 0,
    knownTestPrivateKeyCandidateCount: knownTestPrivateKeys.length,
    chunksContainKnownTestPrivateKey: knownTestPrivateKeys.length > 0 ? matches.knownTestPrivateKeys > 0 : null,
    chunksContainLocalRpcOrOrigin: matches.localRpcOrOrigin > 0,
    chunksContainLocalOnlyChainUx: matches.localOnlyChainUx > 0,
    routeMethodsAreReadOnlyFixtureOnly: onlyFixtureConfigRoute && fixtureHasOnlyGetHandler,
    markerCounts: matches,
    markerFiles: foundFiles,
  };
  artifact.readinessBlockers = Object.entries({
    devApi: artifact.routeManifestsContainDevApi,
    mockRandomness: artifact.chunksContainMockRandomness,
    seededDemoControls: artifact.chunksContainSeededDemoControls,
    knownTestPrivateKeys: artifact.chunksContainKnownTestPrivateKey === true,
    knownTestKeyCandidatesUnavailable: !artifact.knownTestPrivateKeyScanComplete,
    localRpcOrOrigin: artifact.chunksContainLocalRpcOrOrigin,
    localOnlyChainUx: artifact.chunksContainLocalOnlyChainUx,
    configRouteNotReadOnlyFixture: !artifact.routeMethodsAreReadOnlyFixtureOnly,
  }).filter(([, blocked]) => blocked).map(([name]) => name);
  artifact.releaseSafe = artifact.routeManifestFound
    && !artifact.routeManifestsContainDevApi
    && !artifact.chunksContainMockRandomness
    && !artifact.chunksContainSeededDemoControls
    && artifact.knownTestPrivateKeyScanComplete
    && artifact.chunksContainKnownTestPrivateKey === false
    && !artifact.chunksContainLocalRpcOrOrigin
    && !artifact.chunksContainLocalOnlyChainUx
    && artifact.routeMethodsAreReadOnlyFixtureOnly;
  return artifact;
}

export {artifactTestPrefix};
