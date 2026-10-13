import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const PODSPEC_LIMIT_BYTES = 64 * 1024;

const CHECK_LABELS = Object.freeze({
  bundle: 'iOS bundle identifier and portrait/dark phone settings',
  finalDisplay: 'final introspected plist is dark and portrait-only',
  permissions: 'microphone and full-calendar permissions; no reminders permission',
  background: 'no iOS background modes',
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

export function validateIosConfiguration({ config, autolink, podspecContent, projectRoot }) {
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

  mark('background', info?.UIBackgroundModes === undefined ||
    (Array.isArray(info.UIBackgroundModes) && info.UIBackgroundModes.length === 0),
  'Unexpected iOS background modes are configured.');

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

  const result = validateIosConfiguration({ config, autolink, podspecContent, projectRoot });
  for (const label of result.passed) console.log(`OK ${label}`);
  for (const failure of result.failures) console.error(`FAIL ${failure}`);
  if (!result.ok) process.exitCode = 1;
  else console.log('PASS iOS configuration checks complete; this does not compile or sign an iOS app.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCheck();
}
