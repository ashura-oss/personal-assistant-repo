import ExpoModulesCore
import Foundation

private let stillPrivacyProcessLaunchId = UUID().uuidString.lowercased()

public final class StillPrivacyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("StillPrivacy")

    Function("getRuntimeIdentity") { () -> [String: Any] in
      [
        "version": 1,
        "platform": "ios",
        "processLaunchId": stillPrivacyProcessLaunchId,
        "bundleIdentifier": Bundle.main.bundleIdentifier ?? ""
      ]
    }
  }
}
