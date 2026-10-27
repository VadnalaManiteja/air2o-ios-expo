# AIRA voice on iOS

The website UI remains in the WebView. iOS uses `expo-speech-recognition` 3.1.3 (Expo SDK 54) for conversation, composer dictation, and optional foreground wake phrase recognition. Web/Android continue using their browser pipeline.

## Recognition and privacy

- Tap the mic to grant Microphone and Speech Recognition access. Composer dictation fills the input; the waveform button starts a conversation.
- Conversation/dictation use Apple's recognizer and may send audio to Apple's speech service. Their final text goes into the existing AIRA chat flow; iOS does not send PCM to the Whisper STT WebSocket. Response synthesis still uses the existing Kokoro/Nabra endpoints.
- Enable “Hey AIRA” after login. Wake recognition requires on-device **en-US** support, checked by the local `AiraSpeechCapabilities` Expo module. Unsupported devices receive an error and can still use tap-to-talk.
- This is native speech recognition with phrase matching, not a dedicated low-power keyword model. Recognition quality, battery use, and long-session restarts must be measured on target iPhones. It runs only while the app is foregrounded. It pauses for conversation, dictation, and response playback; disabling or logging out releases it.
- Wake recognition is off after a new page load/logout. No background audio entitlement is added.

## Build and deployment

1. Deploy the changed `octane-hvac-customer` application to `https://testcustomer.air2o.net`.
2. In this Expo project run `npm ci`.
3. Build a new native app: `npx eas-cli build --platform ios --profile development` (development client), or `--profile production` for TestFlight distribution. Upload/distribution is a separate release action.
4. Install on a physical iPhone. Expo Go and an OTA update to an old binary do not include the new native modules/permission descriptions.

For a different web deployment, set `EXPO_PUBLIC_WEBSITE_URL=https://your-trusted-host/` in the build environment. It also defines the trusted origin for bridge commands and injected native data. External navigation opens outside the privileged WebView. A phone's `localhost` is the phone itself; use an HTTPS development deployment reachable by the phone.

## Verification

Local checks:

```sh
node --test tests/nativeVoiceController.test.cjs
npx expo-modules-autolinking resolve --platform ios --json
npx expo config --type public
npm run lint
npx tsc --noEmit
```

Physical-device release checks (not replaceable by mocked tests):

1. Fresh install: grant both permissions; dictation inserts text without submitting it. Test denial and recovery in Settings.
2. Verify English, Hindi, and Arabic conversation/dictation locales on supported devices.
3. Complete at least ten conversation turns, including short opening words, cancellation while awaiting a response, stopping playback, and starting again.
4. Enable wake recognition; say “Hey AIRA”, wait for the listening UI, then speak a command. Exit the conversation and confirm wake recognition resumes. Disable wake while idle and confirm recording stops.
5. Start dictation while wake recognition is armed. Confirm exactly one microphone owner and wake re-arms after dictation.
6. Background/foreground, lock/unlock, phone/Siri interruptions, headphones/Bluetooth changes, network loss, logout, WebView reload, and unsupported on-device en-US recognition.
7. Verify speaker playback volume, recognition latency, false wake triggers, 30-minute wake listening stability, and battery/memory use on the oldest supported iPhone and a current model.
8. Repeat existing web and Android flows against the same deployed website.

Development builds show a diagnostics expander in the iOS voice control. On production use `/chat-bot?voiceDebug=1` to expose native readiness, foreground state, voice state, and route without logging transcripts.

## Architecture notes

- The bridge protocol is `AIRA_VOICE`, version 1, with request IDs and start/stop/cancel actions. A ready handshake avoids dropped initial events.
- `NativeVoiceController` waits for native `end` before transferring the microphone. Generation checks cancel pending permission/start work; cancelled results never reach a newer session.
- Full backgrounding cancels recognition. Permission sheets' temporary inactive state is ignored only while awaiting permissions and before capture begins.
- `NativeVoiceEngine` never mounts browser VAD/ONNX on iOS. Cancelled asynchronous chat/TTS work cannot restart a stale conversation.
- `TTSService` aborts pending synthesis, settles cancelled playback, and releases object URLs. Browser wake initialization also releases partial engines on failure instead of deadlocking.

Swift compilation, microphone quality, and actual audio routing require an iOS build and a physical device; Windows checks cannot establish those results.

## Local verification on 2026-10-26

- Native controller: 12 tests passed. Web voice: 14 tests passed.
- Expo lint and TypeScript checks passed; Expo autolinking finds both speech modules.
- iOS production Hermes JavaScript export passed. Windows sandbox temporary-file restrictions required setting TEMP/TMP to this project's ignored `node_modules/.cache` directory for that command.
- Web production build passed with existing warnings (`CI=false`). CI-mode builds fail on existing repository warnings; the full web suite has 64 passing tests and one existing `App.test.js` suite that cannot resolve `react-router-dom` in Jest.
- No EAS build, deployment, Swift compilation, TestFlight install, or physical-iPhone acceptance run was performed.

## Automatic wake update (2026-10-27)

The paired React application now automatically arms foreground Hey AIRA recognition after authentication/native-bridge readiness. The Enable button and normal status panel are removed. Wake listening pauses for dictation, conversation, and response playback and resumes afterward or on foreground return. Logout stops recognition. First-use iOS system permissions still apply. Errors are shown in the chat page; diagnostics remain debug-only.

This update changes only the web application and documentation; the native speech modules/controller remain the ones already tested on the physical iPhone. Deploy the entire new web build and reload the installed app. No additional native build is needed for an installed binary that already contains both speech modules.
