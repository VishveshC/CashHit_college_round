#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
// Registry staging is versioned separately so the Phase 4 frozen base helper stays byte-for-byte intact.
import {createProductionExclusionStage, productionExcludedPaths, readKnownTestPrivateKeys, scanArtifactTestOutput} from './registry-production-artifact-stage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');
const args = process.argv.slice(2);
let target = 'public';
let dry = false;
let evidencePrefix = 'phase4-reopen-artifact-test';
let evidencePrefixSpecified = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--target' && args[i + 1]) target = args[++i];
  else if (args[i] === '--dry-run') dry = true;
  else if (args[i] === '--evidence-prefix' && args[i + 1]) {
    if (evidencePrefixSpecified) throw new Error('--evidence-prefix may be supplied only once.');
    evidencePrefixSpecified = true;
    evidencePrefix = args[++i];
  }
  else throw new Error('Unknown build argument.');
}
if (!/^phase4-reopen-[a-z0-9-]+$/.test(evidencePrefix)) {
  throw new Error('Evidence prefix must match phase4-reopen-[a-z0-9-]+.');
}
if (evidencePrefixSpecified && target !== 'artifact-test') {
  throw new Error('--evidence-prefix is only supported for the isolated artifact-test target.');
}

function artifactEvidencePaths(prefix) {
  return {
    report: path.join(docs, `${prefix}.json`),
    buildLog: path.join(docs, `${prefix}-build.txt`),
  };
}

function requireApprovedPublicInputs() {
  // No approval contract or production adapter/configuration exists in this checkout.
  // Keep this preflight ahead of staging and Next compilation; a future reviewed
  // loader must return the two approved paths consumed by the shared stage helper.
  throw new Error('Public release blocked: No approved production adapter/configuration exists.');
}

function safeBuildEnvironment(targetName) {
  const safe = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[name]) safe[name] = process.env[name];
  }
  safe.CI = '1';
  safe.NEXT_TELEMETRY_DISABLED = '1';
  safe.FAIRWORK_BUILD_TARGET = targetName;
  safe.NEXT_PUBLIC_FAIRWORK_LOCAL = '0';
  return safe;
}

function runNext(stage, {buildTarget, outputDirectory}) {
  const next = path.join(root, 'node_modules/next/dist/bin/next');
  const result = spawnSync(process.execPath, [next, 'build', '--webpack'], {
    cwd: stage.appRoot,
    env: safeBuildEnvironment(buildTarget),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {result, outputDirectory};
}

function publicArtifactStageOptions(approved) {
  return {
    sourceRoot: root,
    target: 'public',
    approvedPublicInputs: {
      approvalStatus: 'approved',
      adapterContractPath: approved.adapterContractPath,
      publicConfigPath: approved.publicConfigPath,
    },
  };
}

async function buildPublicIfApproved() {
  const approved = requireApprovedPublicInputs();
  const stage = await createProductionExclusionStage(publicArtifactStageOptions(approved));
  const {result} = runNext(stage, {buildTarget: 'public', outputDirectory: stage.outputRoot});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

const writeBuildLog = async (content, evidencePath) => {
  await mkdir(docs, {recursive: true});
  await writeFile(evidencePath, content, 'utf8');
};

async function buildArtifactTest(prefix) {
  const evidencePaths = artifactEvidencePaths(prefix);
  const stage = await createProductionExclusionStage({sourceRoot: root, target: 'artifact-test'});
  const knownTestPrivateKeys = await readKnownTestPrivateKeys(root);
  let result = null;
  let artifact = null;
  let buildLog = '';
  try {
    const run = runNext(stage, {buildTarget: 'artifact-test', outputDirectory: stage.outputRoot});
    result = run.result;
    if (result.error) buildLog = `${result.stdout ?? ''}${result.stderr ?? ''}\n${result.error.stack ?? result.error.message}\n`;
    else buildLog = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status === 0) artifact = await scanArtifactTestOutput(stage.outputRoot, {knownTestPrivateKeys});
  } finally {
    await writeBuildLog(buildLog, evidencePaths.buildLog);
  }

  const dashboardSource = stage.stagedFiles.find((file) => file.path.replaceAll('\\', '/') === 'apps/web/components/EscrowDashboard.tsx');
  const registrySource = stage.stagedFiles.find((file) => file.path.replaceAll('\\', '/') === 'apps/web/components/ArbiterRegistry.tsx');
  const report = {
    generatedAt: new Date().toISOString(),
    kind: 'isolated non-deployable artifact-test packaging evidence',
    target: 'artifact-test',
    evidencePrefix: prefix,
    publicTargetRemainsBlocked: true,
    sourceEvidence: {
      dashboardPath: 'apps/web/components/EscrowDashboard.tsx',
      dashboardSha256: dashboardSource?.sha256 ?? null,
      registryComponentPath: 'apps/web/components/ArbiterRegistry.tsx',
      registryComponentSha256: registrySource?.sha256 ?? null,
    },
    build: {
      status: result?.status ?? null,
      signal: result?.signal ?? null,
      outputDirectory: stage.outputRoot,
      outputDirectoryIsOutsideWorkspace: stage.outputDirectoryIsOutsideWorkspace,
      environmentKeysPassed: ['CI', 'FAIRWORK_BUILD_TARGET', 'NEXT_PUBLIC_FAIRWORK_LOCAL', 'NEXT_TELEMETRY_DISABLED', 'PATH/SystemRoot/TEMP/TMP if set'],
      usedRealPublicConfig: false,
      usedPublicDeployment: false,
    },
    exclusions: {
      excludedSourcePaths: [...productionExcludedPaths],
      stagedFiles: stage.stagedFiles,
      stagedFileCount: stage.stagedFiles.length,
      hasMockRandomnessArtifact: stage.stagedFiles.some((file) => file.path.endsWith('MockRandomness.json')),
      hasDevWalletSource: stage.stagedFiles.some((file) => file.path.endsWith('dev-wallet.ts')),
      hasOriginalDeploymentPinVerifier: stage.stagedFiles.some((file) => file.path.replaceAll('\\', '/') === 'apps/web/lib/chain-pins.ts'),
      fixtureConfigRoute: 'GET only; fixed 503; contains no chain, address, RPC or write-handler data',
      sharedProductionChainTransform: 'MockRandomness import and ABI exports removed before compilation',
    },
    knownTestKeyScan: {
      candidateSource: 'apps/web/lib/dev-wallet.ts (read in memory only; excluded from stage)',
      exactCandidatesScanned: knownTestPrivateKeys.length,
      exactComparisonApplicable: knownTestPrivateKeys.length > 0,
      valuesWrittenToReport: false,
    },
    artifact,
    limitations: [
      'This is a temporary staging build, not a production artifact and not deployable.',
      'The fixture config endpoint is a GET-only fixed 503 and contains no runtime handlers or public-write API.',
      'The current dashboard still has chain-31337 behavior and local SIWE/RPC assumptions outside its localBuild-only controls; actual chunk scans report these markers explicitly.',
      'dev-wallet.ts relays requests to an unlocked local RPC and contains no private-key literal list, so exact known-key matching is not applicable and does not prove that key values are absent.',
      'No approved production adapter, chain, RPC, token policy, origin/TLS policy, or rate-limit configuration was supplied.',
      'A green exclusion subset does not prove a future approved public build; that build must run this shared source transform and pass its own actual-output scan.',
    ],
  };
  await mkdir(docs, {recursive: true});
  await writeFile(evidencePaths.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    process.stderr.write(buildLog);
    throw new Error(`Isolated artifact-test Next build failed with status ${result?.status ?? 'unknown'}.`);
  }
  if (!artifact?.routeManifestFound) throw new Error('Artifact scan could not find the Next route manifest.');
  const exclusionScanPassed = artifact?.releaseSafe === true;
  process.stdout.write(`NON-DEPLOYABLE ARTIFACT TEST ${exclusionScanPassed ? 'EXCLUSION SCAN PASS' : 'BLOCKED: actual output failed exclusion scan'}\n`);
  process.stdout.write(JSON.stringify({
    report: path.relative(root, evidencePaths.report).replaceAll('\\', '/'),
    outputDirectory: stage.outputRoot,
    apiRoutes: artifact.apiRoutes,
    routeManifestsContainDevApi: artifact.routeManifestsContainDevApi,
    chunksContainMockRandomness: artifact.chunksContainMockRandomness,
    chunksContainSeededDemoControls: artifact.chunksContainSeededDemoControls,
    chunksContainKnownTestPrivateKey: artifact.chunksContainKnownTestPrivateKey,
    knownTestPrivateKeyScanComplete: artifact.knownTestPrivateKeyScanComplete,
    chunksContainLocalRpcOrOrigin: artifact.chunksContainLocalRpcOrOrigin,
    chunksContainLocalOnlyChainUx: artifact.chunksContainLocalOnlyChainUx,
    routeMethodsAreReadOnlyFixtureOnly: artifact.routeMethodsAreReadOnlyFixtureOnly,
    readinessBlockers: artifact.readinessBlockers,
    releaseSafe: artifact.releaseSafe,
  }, null, 2) + '\n');
  if (!exclusionScanPassed) process.exitCode = 2;
}

if (target === 'public') {
  await buildPublicIfApproved();
} else if (target === 'artifact-test') {
  if (dry) {
    const evidencePaths = artifactEvidencePaths(evidencePrefix);
    process.stdout.write(JSON.stringify({
      target: 'artifact-test',
      evidencePrefix,
      report: path.relative(root, evidencePaths.report).replaceAll('\\', '/'),
      buildLog: path.relative(root, evidencePaths.buildLog).replaceAll('\\', '/'),
      compilationStarted: false,
      filesWritten: false,
    }, null, 2) + '\n');
  } else {
    await buildArtifactTest(evidencePrefix);
  }
} else if (target === 'local') {
  process.stdout.write('Validated local-only chain31337 build; public release remains blocked.\n');
  if (!dry) {
    const next = path.join(root, 'node_modules/next/dist/bin/next');
    const result = spawnSync(process.execPath, [next, 'build'], {
      cwd: path.join(root, 'apps/web'),
      env: {...process.env, FAIRWORK_BUILD_TARGET: 'local', NEXT_PUBLIC_FAIRWORK_LOCAL: '1', NEXT_TELEMETRY_DISABLED: '1'},
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} else {
  throw new Error('Build target must be local, artifact-test, or public.');
}
