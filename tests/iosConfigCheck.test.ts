import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateIosConfiguration } from '../scripts/check-ios-config.mjs';

const projectRoot = process.cwd();
const podspecDir = path.join(projectRoot, 'modules/still-privacy/ios');
const expoFetchSwiftDir = path.join(projectRoot, 'node_modules/expo/ios/Fetch');
const expoFetchTypeDir = path.join(projectRoot, 'node_modules/expo/src/winter/fetch');
const podspecContent = `Pod::Spec.new do |s|
  s.name = 'StillPrivacy'
  s.version = '1.0.0'
  s.summary = 'Native process identity'
  s.license = { :type => 'UNLICENSED' }
  s.author = 'Still'
  s.homepage = 'https://docs.expo.dev/modules/overview/'
  s.platforms = { :ios => '16.4' }
  s.source = { :path => '.' }
  s.swift_version = '5.0'
  s.dependency 'ExpoModulesCore'
end
`;
const backgroundTaskSource = `
  @objc func handleTasksExpiredNotification(_ notification: Notification) {
    self.sendEvent(onTasksExpired, [:])
  }
`;
const expoFetchSource = readFileSync(path.join(expoFetchTypeDir, 'fetch.ts'), 'utf8');
const expoRequestTypeSource = readFileSync(path.join(expoFetchTypeDir, 'NativeRequest.ts'), 'utf8');

function validFixture() {
  const configuredPlist = {
    NSMicrophoneUsageDescription: 'Microphone access description',
    NSCalendarsUsageDescription: 'Calendar access description',
    NSCalendarsFullAccessUsageDescription: 'Full calendar access description',
    UIBackgroundModes: ['processing', 'fetch'],
    BGTaskSchedulerPermittedIdentifiers: ['com.expo.modules.backgroundtask.processing'],
    NSAppTransportSecurity: { NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: true },
    CFBundleURLTypes: [{ CFBundleURLSchemes: ['still', 'com.still.voiceassistant'] }],
  };
  return {
    config: {
      orientation: 'portrait', scheme: ['still'], userInterfaceStyle: 'dark',
      ios: {
        supportsTablet: false,
        bundleIdentifier: 'com.still.voiceassistant',
        infoPlist: { ...configuredPlist },
      },
      _internal: { modResults: { ios: { infoPlist: {
        ...configuredPlist,
        UIUserInterfaceStyle: 'Dark',
        UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown'],
      } } } },
    },
    autolink: {
      modules: [{
        packageName: 'still-privacy',
        debugOnly: false,
        swiftModuleNames: ['StillPrivacy'],
        modules: [{ class: 'StillPrivacyModule' }],
        pods: [{ podName: 'StillPrivacy', podspecDir }],
      }],
    },
    podspecContent,
    backgroundTaskVersion: '57.0.21',
    backgroundTaskSource,
    expoFetchVersion: '57.0.28',
    expoFetchSource,
    expoRequestTypeSource,
    expoFetchModuleSwiftSource: readFileSync(path.join(expoFetchSwiftDir, 'ExpoFetchModule.swift'), 'utf8'),
    expoNativeRequestSwiftSource: readFileSync(path.join(expoFetchSwiftDir, 'NativeRequest.swift'), 'utf8'),
    expoURLSessionTaskSwiftSource: readFileSync(path.join(expoFetchSwiftDir, 'ExpoURLSessionTask.swift'), 'utf8'),
    expoNativeResponseSwiftSource: readFileSync(path.join(expoFetchSwiftDir, 'NativeResponse.swift'), 'utf8'),
    expoFetchTaskLifetimeSwiftSource: readFileSync(path.join(expoFetchSwiftDir, 'FetchTaskLifetime.swift'), 'utf8'),
    expoFetchExceptionsSwiftSource: readFileSync(path.join(expoFetchSwiftDir, 'FetchExceptions.swift'), 'utf8'),
    projectRoot,
  };
}

describe('read-only iOS config validation', () => {
  it('keeps the macOS build handoff script as UTF-8 without BOM and LF-only text', () => {
    const scriptBytes = readFileSync(path.join(projectRoot, 'scripts/build-unsigned-ios.sh'));
    expect(scriptBytes[0]).not.toBe(0xef);
    expect(scriptBytes.includes(0x0d)).toBe(false);
    const attributes = readFileSync(path.join(projectRoot, '.gitattributes'), 'utf8');
    expect(attributes.split(/\r?\n/)).toContain('*.sh text eol=lf');
    expect(scriptBytes.subarray(0, 19).toString('utf8')).toBe('#!/usr/bin/env bash');
  });

  it('accepts the expected app config and resolved StillPrivacy callback/pod', () => {
    const result = validateIosConfiguration(validFixture());
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('accepts bounded Expo TypeScript and Swift sources with CRLF line endings', () => {
    const crlfFixture = validFixture();
    for (const key of [
      'expoFetchSource',
      'expoRequestTypeSource',
      'expoFetchModuleSwiftSource',
      'expoNativeRequestSwiftSource',
      'expoURLSessionTaskSwiftSource',
      'expoNativeResponseSwiftSource',
      'expoFetchTaskLifetimeSwiftSource',
      'expoFetchExceptionsSwiftSource',
    ] as const) {
      crlfFixture[key] = crlfFixture[key].replace(/\r?\n/g, '\r\n');
    }
    expect(validateIosConfiguration(crlfFixture)).toMatchObject({ ok: true, failures: [] });
  });

  it('enforces physical source bounds before normalizing CRLF', () => {
    const oversizedCRLF = validFixture();
    const source = oversizedCRLF.expoNativeRequestSwiftSource.replace(/\r\n?/g, '\n');
    const lineCount = 2048;
    const normalizedPaddingLength = 64 * 1024 - Buffer.byteLength(source, 'utf8') - 512 - lineCount;
    expect(normalizedPaddingLength).toBeGreaterThan(0);
    const paddedLF = `${source}\n/*${'x'.repeat(normalizedPaddingLength)}${'\n'.repeat(lineCount)}*/`;
    oversizedCRLF.expoNativeRequestSwiftSource = paddedLF.replace(/\n/g, '\r\n');
    expect(Buffer.byteLength(paddedLF, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(oversizedCRLF.expoNativeRequestSwiftSource, 'utf8')).toBeGreaterThan(64 * 1024);
    expect(validateIosConfiguration(oversizedCRLF).failures).toContain('The pinned Expo fetch lifetime/cancellation helper is missing or changed.');
  });

  it('rejects a missing or duplicate native module registration', () => {
    const missing = validFixture();
    missing.autolink.modules = [];
    expect(validateIosConfiguration(missing).failures).toContain('StillPrivacy is missing, duplicated, or resolved to an unexpected native callback/pod.');

    const duplicate = validFixture();
    duplicate.autolink.modules.push(duplicate.autolink.modules[0]);
    expect(validateIosConfiguration(duplicate).failures).toContain('StillPrivacy is missing, duplicated, or resolved to an unexpected native callback/pod.');
  });

  it('rejects a dropped native callback and mismatched local podspec resolution', () => {
    const droppedCallback = validFixture();
    droppedCallback.autolink.modules[0].modules = [];
    expect(validateIosConfiguration(droppedCallback).failures).toContain('StillPrivacy is missing, duplicated, or resolved to an unexpected native callback/pod.');

    const wrongPod = validFixture();
    wrongPod.autolink.modules[0].pods[0].podspecDir = path.join(projectRoot, 'elsewhere');
    expect(validateIosConfiguration(wrongPod).failures).toContain('StillPrivacy is missing, duplicated, or resolved to an unexpected native callback/pod.');

    const extraCallback = validFixture();
    extraCallback.autolink.modules[0].modules.push({ class: 'UnexpectedModule' });
    expect(validateIosConfiguration(extraCallback).failures).toContain('StillPrivacy is missing, duplicated, or resolved to an unexpected native callback/pod.');

    const releaseOnly = validFixture();
    releaseOnly.autolink.modules[0].debugOnly = true;
    expect(validateIosConfiguration(releaseOnly).failures).toContain('StillPrivacy is missing, duplicated, or resolved to an unexpected native callback/pod.');
  });

  it('rejects broad ATS policy, missing permissions, and unregistered configured schemes', () => {
    const wrongTransport = validFixture();
    wrongTransport.config._internal.modResults.ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads = true;
    expect(validateIosConfiguration(wrongTransport).failures).toContain('App Transport Security is broader than the approved local-networking policy.');

    const missingPermission = validFixture();
    delete (missingPermission.config._internal.modResults.ios.infoPlist as Record<string, unknown>).NSCalendarsFullAccessUsageDescription;
    expect(validateIosConfiguration(missingPermission).failures).toContain('Required microphone/full-calendar descriptions are missing or a reminders description is present.');

    const droppedScheme = validFixture();
    droppedScheme.config._internal.modResults.ios.infoPlist.CFBundleURLTypes = [];
    expect(validateIosConfiguration(droppedScheme).failures).toContain('One or more configured URL schemes are missing from the resolved iOS URL types.');

    const configOnly = validFixture();
    delete (configOnly.config._internal.modResults.ios as Record<string, unknown>).infoPlist;
    expect(validateIosConfiguration(configOnly).failures).toContain('The final introspected plist is missing dark style or includes an unsupported orientation.');

    const finalLight = validFixture();
    finalLight.config._internal.modResults.ios.infoPlist.UIUserInterfaceStyle = 'Light';
    expect(validateIosConfiguration(finalLight).failures).toContain('The final introspected plist is missing dark style or includes an unsupported orientation.');
  });

  it('requires exactly the unordered SDK TaskManager and BackgroundTask modes', () => {
    const missingMode = validFixture();
    missingMode.config._internal.modResults.ios.infoPlist.UIBackgroundModes = ['processing'];
    expect(validateIosConfiguration(missingMode).failures).toContain('iOS background task configuration must contain only SDK 57 TaskManager fetch and BackgroundTask processing modes plus the Expo scheduler identifier.');

    const duplicateMode = validFixture();
    duplicateMode.config._internal.modResults.ios.infoPlist.UIBackgroundModes.push('fetch');
    expect(validateIosConfiguration(duplicateMode).failures).toContain('iOS background task configuration must contain only SDK 57 TaskManager fetch and BackgroundTask processing modes plus the Expo scheduler identifier.');

    const extraMode = validFixture();
    extraMode.config._internal.modResults.ios.infoPlist.UIBackgroundModes.push('audio');
    expect(validateIosConfiguration(extraMode).failures).toContain('iOS background task configuration must contain only SDK 57 TaskManager fetch and BackgroundTask processing modes plus the Expo scheduler identifier.');

    const remoteNotification = validFixture();
    remoteNotification.config._internal.modResults.ios.infoPlist.UIBackgroundModes.push('remote-notification');
    expect(validateIosConfiguration(remoteNotification).failures).toContain('iOS background task configuration must contain only SDK 57 TaskManager fetch and BackgroundTask processing modes plus the Expo scheduler identifier.');

    const extraIdentifier = validFixture();
    extraIdentifier.config._internal.modResults.ios.infoPlist.BGTaskSchedulerPermittedIdentifiers.push('unexpected.task');
    expect(validateIosConfiguration(extraIdentifier).failures).toContain('iOS background task configuration must contain only SDK 57 TaskManager fetch and BackgroundTask processing modes plus the Expo scheduler identifier.');
  });

  it('rejects an unpatched or version-drifted Expo expiry bridge', () => {
    const oldGuard = validFixture();
    oldGuard.backgroundTaskSource = `
      @objc func handleTasksExpiredNotification(_ notification: Notification) {
        guard let url = notification.userInfo?["url"] as? URL else { return }
        self.sendEvent(onTasksExpired, [:])
      }
    `;
    expect(validateIosConfiguration(oldGuard).failures).toContain('The pinned Expo background-task expiry bridge does not match the approved notification contract.');

    const wrongVersion = validFixture();
    wrongVersion.backgroundTaskVersion = '57.0.22';
    expect(validateIosConfiguration(wrongVersion).failures).toContain('The pinned Expo background-task expiry bridge does not match the approved notification contract.');
  });

  it('rejects an unpatched or version-drifted Expo native request lifetime helper', () => {
    const missing = validFixture();
    missing.expoFetchSource = 'export async function fetch() { return response; }';
    expect(validateIosConfiguration(missing).failures).toContain('The pinned Expo fetch lifetime/cancellation helper is missing or changed.');
    const wrongVersion = validFixture();
    wrongVersion.expoFetchVersion = '57.0.29';
    expect(validateIosConfiguration(wrongVersion).failures).toContain('The pinned Expo fetch lifetime/cancellation helper is missing or changed.');

    const missingTerminalMethod = validFixture();
    missingTerminalMethod.expoRequestTypeSource = 'public cancel(): Promise<void>;';
    expect(validateIosConfiguration(missingTerminalMethod).failures).toContain('The pinned Expo fetch lifetime/cancellation helper is missing or changed.');

    const immediateCancelAck = validFixture();
    immediateCancelAck.expoURLSessionTaskSwiftSource = immediateCancelAck.expoURLSessionTaskSwiftSource.replace(
      /func cancelAndWait[\s\S]*?\n  }/,
      'func cancelAndWait(completion: @escaping @Sendable () -> Void) { urlSessionDelegate.removeDelegate(task: task!); completion() }'
    );
    expect(validateIosConfiguration(immediateCancelAck).failures).toContain('The pinned Expo fetch lifetime/cancellation helper is missing or changed.');

    const missingProcessedTerminal = validFixture();
    missingProcessedTerminal.expoNativeResponseSwiftSource = missingProcessedTerminal.expoNativeResponseSwiftSource.replaceAll('dispatchQueue.async(execute: onProcessed)', 'dispatchQueue.async {}');
    expect(validateIosConfiguration(missingProcessedTerminal).failures).toContain('The pinned Expo fetch lifetime/cancellation helper is missing or changed.');

    const duplicateStartCanHang = validFixture();
    duplicateStartCanHang.expoFetchModuleSwiftSource = duplicateStartCanHang.expoFetchModuleSwiftSource.replace(
      /if startResult == \.alreadyStarted \{[\s\S]*?\n        }/,
      ''
    );
    expect(validateIosConfiguration(duplicateStartCanHang).failures).toContain('The pinned Expo fetch lifetime/cancellation helper is missing or changed.');

    const duplicateStartChangesRedirect = validFixture();
    duplicateStartChangesRedirect.expoNativeRequestSwiftSource = duplicateStartChangesRedirect.expoNativeRequestSwiftSource.replace(
      'case .started:\n      self.response.redirectMode = requestInit.redirect',
      'self.response.redirectMode = requestInit.redirect\n    case .started:'
    );
    expect(validateIosConfiguration(duplicateStartChangesRedirect).failures).toContain('The pinned Expo fetch lifetime/cancellation helper is missing or changed.');
  });

  it('rejects a podspec without its required homepage metadata', () => {
    const missingHomepage = validFixture();
    missingHomepage.podspecContent = missingHomepage.podspecContent.replace("  s.homepage = 'https://docs.expo.dev/modules/overview/'\n", '');
    expect(validateIosConfiguration(missingHomepage).failures).toContain('The local StillPrivacy podspec is missing required bounded metadata.');
  });

  it('rejects an invalid Swift language version in the native podspec', () => {
    const invalidSwiftVersion = validFixture();
    invalidSwiftVersion.podspecContent = invalidSwiftVersion.podspecContent.replace("s.swift_version = '5.0'", "s.swift_version = '5.9'");
    expect(validateIosConfiguration(invalidSwiftVersion).failures).toContain('The local StillPrivacy podspec is missing required bounded metadata.');
  });
});
