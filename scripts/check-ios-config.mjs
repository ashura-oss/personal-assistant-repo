import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const PODSPEC_LIMIT_BYTES = 64 * 1024;
const BACKGROUND_TASK_SOURCE_LIMIT_BYTES = 64 * 1024;
const EXPECTED_BACKGROUND_TASK_VERSION = '57.0.21';
const EXPECTED_EXPO_VERSION = '57.0.28';
const FETCH_SOURCE_LIMIT_BYTES = 64 * 1024;
const FETCH_SWIFT_SOURCE_LIMIT_BYTES = 64 * 1024;

const CHECK_LABELS = Object.freeze({
  bundle: 'iOS bundle identifier and portrait/dark phone settings',
  finalDisplay: 'final introspected plist is dark and portrait-only',
  permissions: 'microphone and full-calendar permissions; no reminders permission',
  background: 'SDK 57 TaskManager fetch and BackgroundTask processing modes only',
  expiryBridge: 'pinned Expo task-expiry event bridge matches the patched iOS notification contract',
  nativeFetchLifetime: 'pinned Expo fetch lifetime waits for processed URLSession task completion',
  transport: 'restricted App Transport Security policy',
  schemes: 'configured URL schemes are registered',
  module: 'StillPrivacy is uniquely autolinked with its native callback',
  podspec: 'StillPrivacy resolves to its local podspec with required metadata',
});

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function nonemptyString(value) { return typeof value === 'string' && value.trim().length > 0; }

function configuredSchemes(scheme) {
  const values = Array.isArray(scheme) ? scheme : [scheme];
  return [...new Set(values.filter(nonemptyString).map((value) => value.trim()))];
}

function registeredSchemes(urlTypes) {
  if (!Array.isArray(urlTypes)) return [];
  return urlTypes.flatMap((entry) => Array.isArray(entry?.CFBundleURLSchemes)
    ? entry.CFBundleURLSchemes.filter(nonemptyString)
    : []);
}

function podspecHasAssignment(source, field, valuePattern) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*s\\.${escaped}\\s*=\\s*${valuePattern}\\s*$`, 'm').test(source);
}

export function validateIosConfiguration({ config, autolink, podspecContent, projectRoot, backgroundTaskVersion, backgroundTaskSource, expoFetchVersion, expoFetchSource, expoRequestTypeSource, expoFetchModuleSwiftSource, expoNativeRequestSwiftSource, expoURLSessionTaskSwiftSource, expoNativeResponseSwiftSource, expoFetchTaskLifetimeSwiftSource, expoFetchExceptionsSwiftSource }) {
  const failures = [];
  const passed = [];
  const mark = (key, valid, failure) => (valid ? passed.push(CHECK_LABELS[key]) : failures.push(failure));
  const ios = config?.ios;
  const info = config?._internal?.modResults?.ios?.infoPlist;

  mark('bundle',
    config?.orientation === 'portrait' && config?.userInterfaceStyle === 'dark' &&
      ios?.supportsTablet === false && ios?.bundleIdentifier === 'com.still.voiceassistant',
    'iOS bundle or device presentation settings are not as expected.');

  const orientations = Array.isArray(info?.UISupportedInterfaceOrientations) ? info.UISupportedInterfaceOrientations : [];
  mark('finalDisplay', object(info) && info.UIUserInterfaceStyle === 'Dark' &&
    orientations.includes('UIInterfaceOrientationPortrait') &&
    orientations.every((orientation) => orientation === 'UIInterfaceOrientationPortrait' || orientation === 'UIInterfaceOrientationPortraitUpsideDown'),
  'The final introspected plist is missing dark style or includes an unsupported orientation.');

  mark('permissions',
    nonemptyString(info?.NSMicrophoneUsageDescription) &&
      nonemptyString(info?.NSCalendarsUsageDescription) &&
      nonemptyString(info?.NSCalendarsFullAccessUsageDescription) &&
      !Object.keys(object(info) ? info : {}).some((key) => /^NSReminders.*UsageDescription$/.test(key)),
    'Required microphone/full-calendar descriptions are missing or a reminders description is present.');

  const backgroundModes = Array.isArray(info?.UIBackgroundModes) ? info.UIBackgroundModes : [];
  // SDK 57's TaskManager plugin adds fetch; BackgroundTask adds processing.
  const expectedBackgroundModes = new Set(['fetch', 'processing']);
  mark('background', backgroundModes.length === expectedBackgroundModes.size &&
    new Set(backgroundModes).size === expectedBackgroundModes.size &&
    backgroundModes.every((mode) => expectedBackgroundModes.has(mode)) &&
    Array.isArray(info?.BGTaskSchedulerPermittedIdentifiers) &&
    info.BGTaskSchedulerPermittedIdentifiers.length === 1 &&
    info.BGTaskSchedulerPermittedIdentifiers[0] === 'com.expo.modules.backgroundtask.processing',
  'iOS background task configuration must contain only SDK 57 TaskManager fetch and BackgroundTask processing modes plus the Expo scheduler identifier.');

  const boundedBackgroundSource = typeof backgroundTaskSource === 'string' &&
    Buffer.byteLength(backgroundTaskSource, 'utf8') <= BACKGROUND_TASK_SOURCE_LIMIT_BYTES
    ? backgroundTaskSource
    : '';
  const expiryHandler = boundedBackgroundSource.match(/handleTasksExpiredNotification\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? '';
  mark('expiryBridge', backgroundTaskVersion === EXPECTED_BACKGROUND_TASK_VERSION &&
    expiryHandler.includes('self.sendEvent(onTasksExpired, [:])') &&
    !/userInfo\s*\?\[\s*["']url["']\s*\]/.test(expiryHandler),
  'The pinned Expo background-task expiry bridge does not match the approved notification contract.');

  const boundedSource = (source, limit) => typeof source === 'string' && Buffer.byteLength(source, 'utf8') <= limit
    ? source.replace(/\r\n?/g, '\n')
    : '';
  const boundedExpoFetchSource = boundedSource(expoFetchSource, FETCH_SOURCE_LIMIT_BYTES);
  const boundedSwift = (source) => boundedSource(source, FETCH_SWIFT_SOURCE_LIMIT_BYTES);
  const lifetimeHelper = boundedExpoFetchSource.match(/export async function withFetchLifetime[\s\S]*?\n}\n/)?.[0] ?? '';
  const boundedRequestType = boundedSource(expoRequestTypeSource, FETCH_SOURCE_LIMIT_BYTES);
  const boundedFetchModule = boundedSwift(expoFetchModuleSwiftSource);
  const boundedNativeRequest = boundedSwift(expoNativeRequestSwiftSource);
  const boundedURLSessionTask = boundedSwift(expoURLSessionTaskSwiftSource);
  const boundedNativeResponse = boundedSwift(expoNativeResponseSwiftSource);
  const boundedLifetime = boundedSwift(expoFetchTaskLifetimeSwiftSource);
  const boundedExceptions = boundedSwift(expoFetchExceptionsSwiftSource);
  const abortBeforeCancel = lifetimeHelper.indexOf('response.abort();') >= 0 &&
    lifetimeHelper.indexOf('response.abort();') < lifetimeHelper.indexOf('await retryCancel()');
  const normalizedBeforeFence = lifetimeHelper.indexOf('normalizeBodyInitAsync(body)') >= 0 &&
    lifetimeHelper.indexOf('normalizeBodyInitAsync(body)') < lifetimeHelper.indexOf('beforeStart?.();');
  const finalFenceBeforeStart = lifetimeHelper.indexOf('beforeStart?.();') >= 0 &&
    lifetimeHelper.indexOf('beforeStart?.();') < lifetimeHelper.indexOf('request.start(');
  const cancelAndWaitBody = boundedURLSessionTask.match(/func cancelAndWait[\s\S]*?\n  }/)?.[0] ?? '';
  const startHandler = boundedFetchModule.match(/AsyncFunction\("start"\)[\s\S]*?\.runOnQueue\(fetchRequestQueue\)/)?.[0] ?? '';
  const requestCancelAndWaitBody = boundedNativeRequest.match(/func cancelAndWait\(promise: Promise\)[\s\S]*?\n  }/)?.[0] ?? '';
  const nativeRequestStart = boundedNativeRequest.match(/func start\([\s\S]*?\n  }/)?.[0] ?? '';
  const lifecycleCancelAndWaitBody = boundedLifetime.match(/func cancelAndWait[\s\S]*?\n  }/)?.[0] ?? '';
  const responseTerminalHandler = boundedNativeResponse.match(/private func handleDidCompleteWithError[\s\S]*?\n  }/)?.[0] ?? '';
  mark('nativeFetchLifetime', expoFetchVersion === EXPECTED_EXPO_VERSION &&
    boundedExpoFetchSource.includes('export async function fetch(') &&
    lifetimeHelper.includes('await cancelAcknowledgement') && lifetimeHelper.includes('onCancelPending?.(retryCancel)') &&
    lifetimeHelper.includes('request.cancelAndWait()') && !/request\.cancel\(\)/.test(lifetimeHelper) &&
    lifetimeHelper.includes('}, 1000)') && lifetimeHelper.includes('clearTimeout(cancelPendingDiagnosticTimer)') &&
    abortBeforeCancel && normalizedBeforeFence && finalFenceBeforeStart && typeof expoRequestTypeSource === 'string' &&
    Buffer.byteLength(expoRequestTypeSource, 'utf8') <= FETCH_SOURCE_LIMIT_BYTES &&
    /public\s+cancel\(\):\s*Promise<void>/.test(boundedRequestType) &&
    /public\s+cancelAndWait\(\):\s*Promise<void>/.test(boundedRequestType) &&
    /AsyncFunction\("cancelAndWait"\)[\s\S]*?request\.cancelAndWait\(promise: promise\)[\s\S]*?\.runOnQueue\(fetchRequestQueue\)/.test(boundedFetchModule) &&
    startHandler.includes('let startResult = request.start(') &&
    /startResult == \.alreadyStarted[\s\S]*?FetchRequestAlreadyStartedException\(\)[\s\S]*?return[\s\S]*?response\.waitFor/.test(startHandler) &&
    nativeRequestStart.indexOf('let started = self.task.start(') >= 0 &&
    nativeRequestStart.indexOf('let started = self.task.start(') < nativeRequestStart.indexOf('case .started:') &&
    nativeRequestStart.indexOf('case .started:') < nativeRequestStart.indexOf('self.response.redirectMode = requestInit.redirect') &&
    nativeRequestStart.includes('case .alreadyStarted:\n      break') &&
    /internal final class FetchRequestAlreadyStartedException: Exception[\s\S]*?already been started/.test(boundedExceptions) &&
    /func cancelAndWait\(promise: Promise\)[\s\S]*?task\.cancelAndWait[\s\S]*?promise\.resolve\(\)/.test(boundedNativeRequest) &&
    requestCancelAndWaitBody.includes('response.emitRequestCanceled()') &&
    /private let lifetime = FetchTaskLifetime\(\)/.test(boundedURLSessionTask) &&
    /lifetime\.didComplete\(\)/.test(boundedURLSessionTask) &&
    cancelAndWaitBody.includes('lifetime.cancelAndWait') && !cancelAndWaitBody.includes('removeDelegate') &&
    /didCompleteWithError error: \(any Error\)\?,[\s\S]*?onProcessed: @escaping @Sendable/.test(boundedNativeResponse) &&
    responseTerminalHandler.includes('onProcessed') &&
    (responseTerminalHandler.match(/dispatchQueue\.async\(execute: onProcessed\)/g) ?? []).length >= 2 &&
    responseTerminalHandler.includes('handleDidCompleteWithError(session: session, task: task, error: error, onProcessed: onProcessed)') &&
    boundedLifetime.includes('case notStarted') && boundedLifetime.includes('case running') && boundedLifetime.includes('case terminal') &&
    boundedLifetime.includes('func didComplete()') && !boundedLifetime.includes('Timer.scheduledTimer') &&
    lifecycleCancelAndWaitBody.indexOf('waiters.append(completion)') >= 0 &&
    lifecycleCancelAndWaitBody.indexOf('waiters.append(completion)') < lifecycleCancelAndWaitBody.indexOf('cancelTask()'),
  'The pinned Expo fetch lifetime/cancellation helper is missing or changed.');

  const ats = info?.NSAppTransportSecurity;
  const atsKeys = object(ats) ? Object.keys(ats).sort() : [];
  mark('transport', object(ats) && ats.NSAllowsArbitraryLoads === false &&
    ats.NSAllowsLocalNetworking === true &&
    atsKeys.join(',') === 'NSAllowsArbitraryLoads,NSAllowsLocalNetworking',
  'App Transport Security is broader than the approved local-networking policy.');

  const requiredSchemes = configuredSchemes(config?.scheme);
  const actualSchemes = registeredSchemes(info?.CFBundleURLTypes);
  mark('schemes', requiredSchemes.includes('still') && requiredSchemes.every((scheme) => actualSchemes.includes(scheme)),
    'One or more configured URL schemes are missing from the resolved iOS URL types.');

  const modules = Array.isArray(autolink?.modules) ? autolink.modules : [];
  const privacyModules = modules.filter((row) => row?.packageName === 'still-privacy');
  const privacyModule = privacyModules.length === 1 ? privacyModules[0] : undefined;
  const callbacks = Array.isArray(privacyModule?.modules) ? privacyModule.modules : [];
  const pods = Array.isArray(privacyModule?.pods) ? privacyModule.pods : [];
  const expectedPodspecDir = projectRoot ? path.resolve(projectRoot, 'modules/still-privacy/ios') : '';
  const actualPodspec = pods.length === 1 && nonemptyString(pods[0]?.podName) &&
    pods[0].podName === 'StillPrivacy' && nonemptyString(pods[0]?.podspecDir) &&
    path.resolve(pods[0].podspecDir) === expectedPodspecDir;
  const swiftModuleNames = Array.isArray(privacyModule?.swiftModuleNames) ? privacyModule.swiftModuleNames : [];
  mark('module', privacyModules.length === 1 && privacyModule?.debugOnly === false &&
    callbacks.length === 1 && callbacks[0]?.class === 'StillPrivacyModule' &&
    swiftModuleNames.includes('StillPrivacy') && actualPodspec,
    'StillPrivacy is missing, duplicated, or resolved to an unexpected native callback/pod.');

  const podspec = typeof podspecContent === 'string' && Buffer.byteLength(podspecContent, 'utf8') <= PODSPEC_LIMIT_BYTES
    ? podspecContent
    : '';
  const requiredPodspecMetadata = [
    podspecHasAssignment(podspec, 'name', "['\"]StillPrivacy['\"]"),
    podspecHasAssignment(podspec, 'version', "['\"]1\\.0\\.0['\"]"),
    podspecHasAssignment(podspec, 'summary', "['\"][^'\"]+['\"]"),
    podspecHasAssignment(podspec, 'license', '\\{[^\\n]*\\}'),
    podspecHasAssignment(podspec, 'author', "['\"][^'\"]+['\"]"),
    podspecHasAssignment(podspec, 'homepage', "['\"]https://docs\\.expo\\.dev/modules/overview/['\"]"),
    podspecHasAssignment(podspec, 'platforms', '\\{[^\\n]*\\}'),
    podspecHasAssignment(podspec, 'source', '\\{[^\\n]*\\}'),
    podspecHasAssignment(podspec, 'swift_version', "['\\\"]5\\.0['\\\"]"),
    /s\.dependency\s+['"]ExpoModulesCore['"]/.test(podspec),
  ].every(Boolean);
  const podspecFilePresent = expectedPodspecDir !== '' && existsSync(path.join(expectedPodspecDir, 'StillPrivacy.podspec'));
  mark('podspec', podspec.length > 0 && requiredPodspecMetadata && podspecFilePresent,
    'The local StillPrivacy podspec is missing required bounded metadata.');

  return Object.freeze({ ok: failures.length === 0, passed: Object.freeze(passed), failures: Object.freeze(failures) });
}

function runFile(file, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [file, ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    }, (error, stdout) => {
      if (error) { reject(error); return; }
      resolve(stdout);
    });
  });
}

async function runCheck() {
  const projectRoot = process.cwd();
  const require = createRequire(import.meta.url);
  let configOutput;
  let autolinkOutput;
  try {
    const expoPackage = require.resolve('expo/package.json');
    const autolinkingPackage = require.resolve('expo-modules-autolinking/package.json');
    configOutput = await runFile(path.join(path.dirname(expoPackage), 'bin/cli'), ['config', '--type', 'introspect', '--json'], projectRoot);
    autolinkOutput = await runFile(path.join(path.dirname(autolinkingPackage), 'bin/expo-modules-autolinking.js'), ['resolve', '--platform', 'apple', '--json', '--project-root', projectRoot], projectRoot);
  } catch {
    console.error('FAIL Installed Expo configuration tools could not complete the read-only check.');
    process.exitCode = 1;
    return;
  }

  let config;
  let autolink;
  try {
    config = JSON.parse(configOutput);
    autolink = JSON.parse(autolinkOutput);
  } catch {
    console.error('FAIL Installed Expo tools returned invalid configuration data.');
    process.exitCode = 1;
    return;
  }

  let podspecContent = '';
  try {
    const podspecPath = path.join(projectRoot, 'modules/still-privacy/ios/StillPrivacy.podspec');
    const stat = statSync(podspecPath);
    if (stat.isFile() && stat.size <= PODSPEC_LIMIT_BYTES) {
      podspecContent = readFileSync(podspecPath, 'utf8');
    }
  } catch { /* The fixed podspec check below reports absence without exposing path details. */ }

  let backgroundTaskVersion = '';
  let backgroundTaskSource = '';
  try {
    const backgroundTaskPackage = require.resolve('expo-background-task/package.json');
    const parsedPackage = JSON.parse(readFileSync(backgroundTaskPackage, 'utf8'));
    if (parsedPackage?.version === EXPECTED_BACKGROUND_TASK_VERSION) {
      backgroundTaskVersion = parsedPackage.version;
      const sourcePath = path.join(path.dirname(backgroundTaskPackage), 'ios/BackgroundTaskModule.swift');
      const sourceStat = statSync(sourcePath);
      if (sourceStat.isFile() && sourceStat.size <= BACKGROUND_TASK_SOURCE_LIMIT_BYTES) {
        backgroundTaskSource = readFileSync(sourcePath, 'utf8');
      }
    }
  } catch { /* The fixed pinned-source check below reports absence without exposing paths. */ }

  let expoFetchVersion = '';
  let expoFetchSource = '';
  let expoRequestTypeSource = '';
  let expoFetchModuleSwiftSource = '';
  let expoNativeRequestSwiftSource = '';
  let expoURLSessionTaskSwiftSource = '';
  let expoNativeResponseSwiftSource = '';
  let expoFetchTaskLifetimeSwiftSource = '';
  let expoFetchExceptionsSwiftSource = '';
  try {
    const expoPackage = require.resolve('expo/package.json');
    const parsedPackage = JSON.parse(readFileSync(expoPackage, 'utf8'));
    if (parsedPackage?.version === EXPECTED_EXPO_VERSION) {
      expoFetchVersion = parsedPackage.version;
      const expoRoot = path.dirname(expoPackage);
      const fetchPath = path.join(expoRoot, 'src/winter/fetch/fetch.ts');
      const requestTypePath = path.join(expoRoot, 'src/winter/fetch/NativeRequest.ts');
      const swiftRoot = path.join(expoRoot, 'ios/Fetch');
      const fetchStat = statSync(fetchPath);
      const requestTypeStat = statSync(requestTypePath);
      const readBounded = (filePath, limit) => {
        const sourceStat = statSync(filePath);
        return sourceStat.isFile() && sourceStat.size <= limit ? readFileSync(filePath, 'utf8') : '';
      };
      if (fetchStat.isFile() && fetchStat.size <= FETCH_SOURCE_LIMIT_BYTES) expoFetchSource = readFileSync(fetchPath, 'utf8');
      if (requestTypeStat.isFile() && requestTypeStat.size <= FETCH_SOURCE_LIMIT_BYTES) expoRequestTypeSource = readFileSync(requestTypePath, 'utf8');
      expoFetchModuleSwiftSource = readBounded(path.join(swiftRoot, 'ExpoFetchModule.swift'), FETCH_SWIFT_SOURCE_LIMIT_BYTES);
      expoNativeRequestSwiftSource = readBounded(path.join(swiftRoot, 'NativeRequest.swift'), FETCH_SWIFT_SOURCE_LIMIT_BYTES);
      expoURLSessionTaskSwiftSource = readBounded(path.join(swiftRoot, 'ExpoURLSessionTask.swift'), FETCH_SWIFT_SOURCE_LIMIT_BYTES);
      expoNativeResponseSwiftSource = readBounded(path.join(swiftRoot, 'NativeResponse.swift'), FETCH_SWIFT_SOURCE_LIMIT_BYTES);
      expoFetchTaskLifetimeSwiftSource = readBounded(path.join(swiftRoot, 'FetchTaskLifetime.swift'), FETCH_SWIFT_SOURCE_LIMIT_BYTES);
      expoFetchExceptionsSwiftSource = readBounded(path.join(swiftRoot, 'FetchExceptions.swift'), FETCH_SWIFT_SOURCE_LIMIT_BYTES);
    }
  } catch { /* The fixed pinned-source check below reports absence without exposing paths. */ }

  const result = validateIosConfiguration({ config, autolink, podspecContent, projectRoot, backgroundTaskVersion, backgroundTaskSource, expoFetchVersion, expoFetchSource, expoRequestTypeSource, expoFetchModuleSwiftSource, expoNativeRequestSwiftSource, expoURLSessionTaskSwiftSource, expoNativeResponseSwiftSource, expoFetchTaskLifetimeSwiftSource, expoFetchExceptionsSwiftSource });
  for (const label of result.passed) console.log(`OK ${label}`);
  for (const failure of result.failures) console.error(`FAIL ${failure}`);
  if (!result.ok) process.exitCode = 1;
  else console.log('PASS iOS configuration checks complete; this does not compile or sign an iOS app.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCheck();
}
