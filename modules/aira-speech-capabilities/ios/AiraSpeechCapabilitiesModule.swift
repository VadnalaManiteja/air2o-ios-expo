import ExpoModulesCore
import Speech

public class AiraSpeechCapabilitiesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AiraSpeechCapabilities")
    Function("supportsOnDeviceRecognition") { (language: String) -> Bool in
      guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)) else {
        return false
      }
      return recognizer.isAvailable && recognizer.supportsOnDeviceRecognition
    }
  }
}
