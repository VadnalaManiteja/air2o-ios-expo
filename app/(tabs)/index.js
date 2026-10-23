import messaging from '@react-native-firebase/messaging';
import { AudioModule, setAudioModeAsync } from 'expo-audio';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Platform, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

// Point directly to the screen where the voice assistant is mounted
const WEBSITE_URL = 'https://testcustomer.air2o.net/machinescreen1';

const ASK_MIC_ON_START = true;
const DEBUG_ALERTS = false;
const FORWARD_WEB_LOGS = true;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function App() {
  const webviewRef = useRef(null);

  const [location, setLocation] = useState(null);
  const [fcmToken, setFcmToken] = useState('');
  const [webViewLoaded, setWebViewLoaded] = useState(false);
  const [micGranted, setMicGranted] = useState(false);

  // ---------------------------------------------------------------
  // AUDIO SESSION CONFIGURATION
  // ---------------------------------------------------------------
  const configureAudioSession = useCallback(async () => {
    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
      console.log('[Native] Audio session configured successfully');
    } catch (error) {
      console.log('[Native] Audio session error:', error);
    }
  }, []);

  // ---------------------------------------------------------------
  // NATIVE MICROPHONE PERMISSIONS
  // ---------------------------------------------------------------
  const requestMicPermission = useCallback(async () => {
    try {
      const current = await AudioModule.getRecordingPermissionsAsync();

      if (current.granted) {
        setMicGranted(true);
        await configureAudioSession();
        return true;
      }

      const result = await AudioModule.requestRecordingPermissionsAsync();
      setMicGranted(result.granted);

      if (result.granted) {
        await configureAudioSession();
      } else if (!result.canAskAgain) {
        Alert.alert(
          'Microphone needed',
          'Microphone access is turned off. Please enable it in Settings to use voice features.',
          [
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
            { text: 'Cancel', style: 'cancel' },
          ]
        );
      }

      return result.granted;
    } catch (error) {
      console.log('[Native] Mic permission error:', error);
      return false;
    }
  }, [configureAudioSession]);

  useEffect(() => {
    if (ASK_MIC_ON_START) {
      requestMicPermission();
    }
  }, [requestMicPermission]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && micGranted) {
        configureAudioSession();
      }
    });
    return () => sub.remove();
  }, [micGranted, configureAudioSession]);

  // ---------------------------------------------------------------
  // LOCATION & FCM
  // ---------------------------------------------------------------
  useEffect(() => {
    const getLocation = async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const currentLocation = await Location.getCurrentPositionAsync({});
          setLocation(currentLocation);
        }
      } catch (error) {
        console.log('[Native] Location error:', error);
      }
    };
    getLocation();
  }, []);

  useEffect(() => {
    registerForPushNotificationsAsync();
    const unsubscribe = messaging().onMessage(async (remoteMessage) => {
      console.log('[Native] Foreground notification:', remoteMessage);
    });
    return unsubscribe;
  }, []);

  async function registerForPushNotificationsAsync() {
    try {
      if (!Device.isDevice) return;

      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }
      if (finalStatus !== 'granted') return;

      await messaging().registerDeviceForRemoteMessages();
      await messaging().requestPermission();

      const token = await messaging().getToken();
      setFcmToken(token);
    } catch (error) {
      console.log('[Native] FCM ERROR:', error);
    }
  }

  // ---------------------------------------------------------------
  // SCRIPT INJECTED BEFORE PAGE LOADS
  // ---------------------------------------------------------------
  const injectedBeforeLoad = `
    (function () {
      function post(obj) {
        try {
          if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(JSON.stringify(obj));
<<<<<<< HEAD
          }
        } catch (e) {}
      }

      // Identify environment cleanly
=======
        } catch (e) {}
      }

      // 0) Let the website know it runs inside the native app.
      //    __AIRA_IOS_APP__ enables iOS debug logging in useVoiceAssistant.ts.
      //    Do NOT set __AIRA_USE_NATIVE_WAKEWORD__: wake word runs in-page
      //    (openWakeWord WASM, path A in WAKE_WORD_README.md) and that flag
      //    would disable it.
>>>>>>> e15cac2 (Fix: syntax error in index.js)
      window.__AIRA_NATIVE_APP__ = true;
      window.__AIRA_IOS_APP__ = ${Platform.OS === 'ios' ? 'true' : 'false'};

      // Forward browser logs to React Native console
      if (${FORWARD_WEB_LOGS ? 'true' : 'false'}) {
        ['log', 'warn', 'error'].forEach(function (level) {
          var original = console[level];
          console[level] = function () {
            try {
              var args = Array.prototype.slice.call(arguments).map(function (a) {
                try { return typeof a === 'string' ? a : JSON.stringify(a); }
                catch (e) { return String(a); }
              });
              post({ type: 'WEB_LOG', level: level, message: args.join(' ').slice(0, 800) });
            } catch (e) {}
            original.apply(console, arguments);
          };
        });

        window.addEventListener('error', function (e) {
          post({ type: 'WEB_LOG', level: 'error', message: 'window.onerror: ' + e.message });
        });
        window.addEventListener('unhandledrejection', function (e) {
          post({ type: 'WEB_LOG', level: 'error', message: 'unhandledrejection: ' + (e.reason && (e.reason.name + ': ' + e.reason.message)) });
        });
      }

      // Safe AudioContext auto-unlock without breaking prototypes
      var unlockAudio = function() {
        if (window.__airaAudioUnlocked) return;
        var AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          try {
            var dummyCtx = new AudioCtx();
            dummyCtx.resume().then(function() {
              window.__airaAudioUnlocked = true;
              dummyCtx.close();
            }).catch(function() {});
          } catch(e) {}
        }
      };

      document.addEventListener('touchstart', unlockAudio, { passive: true, once: true });
      document.addEventListener('click', unlockAudio, { passive: true, once: true });
    })();
    true;
  `;

  // ---------------------------------------------------------------
  // RECEIVE MESSAGES FROM WEBVIEW
  // ---------------------------------------------------------------
  const handleWebViewMessage = (event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      switch (data.type) {
        case 'WEB_LOG':
          console.log(`[WEB ${data.level.toUpperCase()}]`, data.message);
          break;
        case 'REQUEST_MIC':
          requestMicPermission();
          break;
<<<<<<< HEAD
=======

        case 'REQUEST_MIC': {
          const granted = await requestMicPermission();
          sendMicStatusToWebsite(granted);
          break;
        }

        case 'MIC_RESULT':
          console.log('Mic test result:', data);
          if (DEBUG_ALERTS) {
            Alert.alert(
              'Mic test',
              data.ok ? 'Granted ✅' : `Failed ❌\n${data.error}`
            );
          }
          break;

        // ----- Wake-word bridge (see useVoiceAssistant.ts) -----
        // Sent on every assistant state transition (IDLE, LISTENING, ...).
        case 'ASSISTANT_STATE_CHANGE':
          console.log('[Aira] state ->', data.state);
          // Wake word / VAD just took the mic: make sure iOS keeps TTS on
          // the speaker and the session still allows recording.
          if (micGranted && data.state === 'LISTENING') {
            configureAudioSession();
          }
          break;

        // Native wake-word engine commands. Only sent when
        // __AIRA_USE_NATIVE_WAKEWORD__ is set (path B). With path A the
        // engine runs in the page, so there is nothing to start/stop here.
        case 'wakeword:ready':
        case 'wakeword:pause':
        case 'wakeword:resume':
          console.log('[Aira] wake-word bridge:', data.type);
          break;

>>>>>>> e15cac2 (Fix: syntax error in index.js)
        default:
          console.log('[Native] Message from website:', data);
      }
    } catch {
      console.log('[Native] Raw message:', event.nativeEvent.data);
    }
  };

  return (
    <View style={styles.container}>
      <WebView
        ref={webviewRef}
        source={{ uri: WEBSITE_URL }}
        style={styles.webview}
        injectedJavaScriptBeforeContentLoaded={injectedBeforeLoad}
        javaScriptEnabled
        cacheEnabled={true}
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsAirPlayForMediaPlayback={false}
        // CRITICAL FOR IOS MIC: Must be "grant", not "grantIfSameHostElsePrompt"
        mediaCapturePermissionGrantType="grant"
        allowsBackForwardNavigationGestures={false}
        onLoadStart={() => setWebViewLoaded(false)}
        onLoadEnd={() => setWebViewLoaded(true)}
        onMessage={handleWebViewMessage}
        onContentProcessDidTerminate={() => {
          console.log('[Native] WebView process terminated, reloading...');
          webviewRef.current?.reload();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  webview: {
    flex: 1,
  },
});