import messaging from '@react-native-firebase/messaging';
import { AudioModule } from 'expo-audio';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { NativeVoiceController } from '../../services/nativeVoiceController';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Platform } from 'react-native';
import { WebView } from 'react-native-webview';

const WEBSITE_URL = process.env.EXPO_PUBLIC_WEBSITE_URL || 'https://testcustomer.air2o.net/';
const TRUSTED_ORIGIN = new URL(WEBSITE_URL).origin;
const isTrustedUrl = (url) => {
  try { return new URL(url).origin === TRUSTED_ORIGIN; } catch { return false; }
};

// true  = ask for the microphone as soon as the app opens
// false = ask only when the website sends { type: 'REQUEST_MIC' }
const ASK_MIC_ON_START = Platform.OS !== 'ios';

// Show on-screen alerts for mic test results (useful in TestFlight).
// Set to false before the final App Store release.
const DEBUG_ALERTS = __DEV__;

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
  const voiceController = useRef(null);
  const trustedPage = useRef(false);

  const emitVoice = useCallback((payload) => {
    if (!trustedPage.current) return;
    webviewRef.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('airaNativeVoice', {detail: ${JSON.stringify(payload)}})); true;`);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const capabilities = requireOptionalNativeModule('AiraSpeechCapabilities');
    const controller = new NativeVoiceController(ExpoSpeechRecognitionModule, emitVoice,
      language => capabilities?.supportsOnDeviceRecognition(language) === true);
    voiceController.current = controller;
    controller.setForeground(AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', state => {
      // iOS permission sheets briefly mark the app inactive. No capture exists
      // yet; allow the initiating tap to finish after the user grants access.
      if (!controller.setAppState(state)) return;
      emitVoice({ event: 'appState', active: state === 'active' });
    });
    return () => {
      subscription.remove();
      controller.dispose();
      voiceController.current = null;
    };
  }, [emitVoice]);

  const [location, setLocation] = useState(null);
  const [fcmToken, setFcmToken] = useState('');
  const [webViewLoaded, setWebViewLoaded] = useState(false);
  const [micGranted, setMicGranted] = useState(false);

  // ---------------------------------------------------------------
  // MICROPHONE (native iOS / Android permission)
  // ---------------------------------------------------------------
  const requestMicPermission = useCallback(async () => {
    try {
      const current = await AudioModule.getRecordingPermissionsAsync();

      if (current.granted) {
        setMicGranted(true);
        return true;
      }

      // Shows the iOS "Air2o Would Like to Access the Microphone" popup
      const result = await AudioModule.requestRecordingPermissionsAsync();
      setMicGranted(result.granted);

      if (!result.granted && !result.canAskAgain) {
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
      console.log('Mic permission error:', error);
      return false;
    }
  }, []);

  useEffect(() => {
    if (ASK_MIC_ON_START) {
      requestMicPermission();
    }
  }, [requestMicPermission]);

  // Tell the website the current mic permission state
  const sendMicStatusToWebsite = useCallback((granted) => {
    if (!trustedPage.current) return;
    const script = `
      (function () {
        window.__airaMicGranted = ${granted ? 'true' : 'false'};
        window.dispatchEvent(
          new CustomEvent('micPermissionFromApp', {
            detail: { granted: ${granted ? 'true' : 'false'} }
          })
        );
      })();
      true;
    `;
    webviewRef.current?.injectJavaScript(script);
  }, []);

  // ---------------------------------------------------------------
  // LOCATION
  // ---------------------------------------------------------------
  useEffect(() => {
    const getLocation = async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();

        if (status !== 'granted') {
          Alert.alert('Location permission denied');
          return;
        }

        const currentLocation = await Location.getCurrentPositionAsync({});
        setLocation(currentLocation);
        console.log('Location:', currentLocation.coords);
      } catch (error) {
        console.log('Location error:', error);
      }
    };

    getLocation();
  }, []);

  // ---------------------------------------------------------------
  // FCM
  // ---------------------------------------------------------------
  useEffect(() => {
    registerForPushNotificationsAsync();

    const unsubscribe = messaging().onMessage(async (remoteMessage) => {
      console.log('Foreground notification:', remoteMessage);
    });

    return unsubscribe;
  }, []);

  async function registerForPushNotificationsAsync() {
    try {
      if (!Device.isDevice) {
        Alert.alert('Must use a physical device');
        return;
      }

      const { status: existingStatus } =
        await Notifications.getPermissionsAsync();

      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      if (finalStatus !== 'granted') {
        Alert.alert('Notification permission denied');
        return;
      }

      await messaging().registerDeviceForRemoteMessages();
      await messaging().requestPermission();

      const token = await messaging().getToken();
      console.log('FCM TOKEN:', token);
      setFcmToken(token);
    } catch (error) {
      console.log('FCM ERROR:', error);
    }
  }

  // ---------------------------------------------------------------
  // JS injected into the website (runs on every page load)
  // ---------------------------------------------------------------
  const injectedJS = `
    (function () {
      if (window.location.origin !== ${JSON.stringify(TRUSTED_ORIGIN)}) return;
      window.__AIRA_IOS_APP__ = ${Platform.OS === 'ios'};
      window.__AIRA_NATIVE_VOICE__ = ${Platform.OS === 'ios'};
      window.__AIRA_VOICE_DEBUG__ = ${__DEV__};
      window.dispatchEvent(new CustomEvent('airaNativeReady'));
      // 1) Diagnostics: is the mic API available in this WebView?
      var micCheck = {
        type: 'MIC_CHECK',
        secure: window.isSecureContext,
        mediaDevices: !!navigator.mediaDevices,
        getUserMedia: typeof (navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
      };
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(micCheck));

      // 2) Helpers your website can call
      // Ask the native app to request mic permission:
      //    window.requestNativeMic()
      window.requestNativeMic = function () {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'REQUEST_MIC' }));
      };

      // Real test of getUserMedia. Call from a button tap:
      //    window.testMic()
      window.testMic = function () {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'MIC_RESULT', ok: false, error: 'mediaDevices undefined'
          }));
          return;
        }
        navigator.mediaDevices.getUserMedia({ audio: true })
          .then(function (stream) {
            stream.getTracks().forEach(function (t) { t.stop(); });
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'MIC_RESULT', ok: true }));
          })
          .catch(function (e) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'MIC_RESULT', ok: false, error: e.name + ': ' + e.message
            }));
          });
      };
    })();

    true;
  `;

  // ---------------------------------------------------------------
  // SEND LOCATION + FCM TOKEN TO WEBSITE
  // ---------------------------------------------------------------
  useEffect(() => {
    if (!webViewLoaded || !trustedPage.current) return;

    const appData = {
      fcmToken,
      micGranted,
      location: {
        latitude: location?.coords?.latitude ?? 0,
        longitude: location?.coords?.longitude ?? 0,
      },
    };

    const script = `
      (function () {
        const data = ${JSON.stringify(appData)};

        window.fcmToken = data.fcmToken;

        window.dispatchEvent(
          new CustomEvent('locationFromApp', { detail: data.location })
        );

        window.dispatchEvent(
          new CustomEvent('appDataFromNative', { detail: data })
        );
      })();

      true;
    `;

    webviewRef.current?.injectJavaScript(script);
  }, [webViewLoaded, location, fcmToken, micGranted]);

  // ---------------------------------------------------------------
  // RECEIVE MESSAGES FROM WEBSITE
  // ---------------------------------------------------------------
  const handleWebViewMessage = async (event) => {
    if (!trustedPage.current || !isTrustedUrl(event.nativeEvent.url)) return;
    try {
      const data = JSON.parse(event.nativeEvent.data);

      switch (data.type) {
        case 'AIRA_VOICE':
          if (data.version === 1 && typeof data.requestId === 'string' && data.requestId.length < 150) {
            await voiceController.current?.handle(data);
          }
          break;
        case 'AIRA_VOICE_READY':
          webviewRef.current?.injectJavaScript(injectedJS);
          sendMicStatusToWebsite((await AudioModule.getRecordingPermissionsAsync()).granted);
          emitVoice({ event: 'appState', active: AppState.currentState === 'active' });
          break;
        case 'MIC_CHECK':
          console.log('Microphone check:', data);
          if (Platform.OS !== 'ios' && (!data.mediaDevices || data.getUserMedia !== 'function')) {
            console.log('Microphone API is unavailable inside this WebView.');
            if (DEBUG_ALERTS) {
              Alert.alert('Mic API unavailable', JSON.stringify(data));
            }
          }
          break;

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

        default:
          console.log('Message from website:', data);
      }
    } catch (_error) {
      console.log('WebView message:', event.nativeEvent.data);
    }
  };

  return (
    <WebView
      ref={webviewRef}
      source={{ uri: WEBSITE_URL }}
      style={{ flex: 1 }}
      injectedJavaScriptBeforeContentLoaded={injectedJS}
      injectedJavaScript={injectedJS}
      onShouldStartLoadWithRequest={(request) => {
        if (isTrustedUrl(request.url)) return true;
        if (/^https?:/.test(request.url) && request.isTopFrame !== false) void Linking.openURL(request.url);
        return false;
      }}
      javaScriptEnabled
      domStorageEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      // iOS 15+: don't show a second popup for your own website
      mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
      onLoadStart={(event) => {
        trustedPage.current = isTrustedUrl(event.nativeEvent.url);
        void voiceController.current?.handle({ action: 'cancel', requestId: '*' });
        setWebViewLoaded(false);
        console.log('Website loading...');
      }}
      onLoadEnd={() => {
        console.log('Website loaded successfully');
        setWebViewLoaded(true);
      }}
      onMessage={handleWebViewMessage}
      onContentProcessDidTerminate={() => {
        void voiceController.current?.handle({ action: 'cancel', requestId: '*' });
        webviewRef.current?.reload();
      }}
      onError={(event) => {
        console.log('WebView Error:', event.nativeEvent);
      }}
      onHttpError={(event) => {
        console.log('HTTP Error:', event.nativeEvent);
      }}
    />
  );
}
