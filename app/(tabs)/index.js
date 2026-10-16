import messaging from '@react-native-firebase/messaging';
import { AudioModule, setAudioModeAsync } from 'expo-audio';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Platform } from 'react-native';
import { WebView } from 'react-native-webview';

const WEBSITE_URL = 'https://testcustomer.air2o.net/';

// true  = ask for the microphone as soon as the app opens
// false = ask only when the website sends { type: 'REQUEST_MIC' }
const ASK_MIC_ON_START = true;

// Show on-screen alerts for mic test results (useful in TestFlight).
// Set to false before the final App Store release.
const DEBUG_ALERTS = true;

// Forward the website's console.log/warn/error + errors to the RN console
// (visible in Xcode / `npx expo start` logs). Set false for release.
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
  // iOS AUDIO SESSION
  // Without this, once the mic is active iOS routes TTS to the earpiece
  // (very quiet) or mutes it when the ringer switch is on silent.
  // Must be called AFTER mic permission is granted.
  // ---------------------------------------------------------------
  const configureAudioSession = useCallback(async () => {
    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: 'duckOthers',
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
      console.log('Audio session configured');
    } catch (error) {
      console.log('Audio session error:', error);
    }
  }, []);

  // ---------------------------------------------------------------
  // MICROPHONE (native iOS / Android permission)
  // ---------------------------------------------------------------
  const requestMicPermission = useCallback(async () => {
    try {
      const current = await AudioModule.getRecordingPermissionsAsync();

      if (current.granted) {
        setMicGranted(true);
        await configureAudioSession();
        return true;
      }

      // Shows the iOS "Air2o Would Like to Access the Microphone" popup
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
      console.log('Mic permission error:', error);
      return false;
    }
  }, [configureAudioSession]);

  useEffect(() => {
    if (ASK_MIC_ON_START) {
      requestMicPermission();
    }
  }, [requestMicPermission]);

  // iOS can drop/alter the audio session when the app goes to background
  // and returns. Re-apply it when the app becomes active again.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && micGranted) {
        configureAudioSession();
      }
    });
    return () => sub.remove();
  }, [micGranted, configureAudioSession]);

  // Tell the website the current mic permission state
  const sendMicStatusToWebsite = useCallback((granted) => {
    const script = `
      (function () {
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
  // JS injected BEFORE the website loads (so the patches are in place
  // before the website's own code creates AudioContexts / mic streams)
  // ---------------------------------------------------------------
  const injectedBeforeLoad = `
    (function () {
      function post(obj) {
        try {
          window.ReactNativeWebView &&
            window.ReactNativeWebView.postMessage(JSON.stringify(obj));
        } catch (e) {-}
      }

      // 0) Let the website know it runs inside the native app
      window.__AIRA_NATIVE_APP__ = true;
      window.__AIRA_IOS_APP__ = ${Platform.OS === 'ios' ? 'true' : 'false'};

      // 1) Forward website logs + uncaught errors to React Native
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

      // 2) iOS fix: AudioContexts created without a user tap start
      //    "suspended" and never process audio. Track them and resume them
      //    on creation and on every touch.
      var Native = window.AudioContext || window.webkitAudioContext;
      if (Native && !window.__airaAudioPatched) {
        window.__airaAudioPatched = true;
        var contexts = [];

        function resumeAll() {
          contexts.forEach(function (c) {
            if (c.state === 'suspended' || c.state === 'interrupted') {
              c.resume().catch(function () {});
            }
          });
        }

        var Patched = function (opts) {
          var ctx = opts ? new Native(opts) : new Native();
          contexts.push(ctx);
          ctx.addEventListener('statechange', function () {
            post({ type: 'WEB_LOG', level: 'log', message: 'AudioContext state -> ' + ctx.state });
            if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
              ctx.resume().catch(function () {});
            }
          });
          ctx.resume().catch(function () {});
          return ctx;
        };
        Patched.prototype = Native.prototype;
        window.AudioContext = Patched;
        window.webkitAudioContext = Patched;

        ['touchstart', 'touchend', 'click'].forEach(function (ev) {
          document.addEventListener(ev, resumeAll, { passive: true });
        });
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) resumeAll();
        });
      }

      // 3) Log getUserMedia calls + what happens to the mic tracks
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        var originalGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = function (constraints) {
          post({ type: 'WEB_LOG', level: 'log', message: 'getUserMedia requested: ' + JSON.stringify(constraints) });
          return originalGUM(constraints).then(
            function (stream) {
              stream.getAudioTracks().forEach(function (track) {
                post({ type: 'WEB_LOG', level: 'log', message: 'mic track started: ' + track.label + ' state=' + track.readyState });
                track.addEventListener('mute', function () {
                  post({ type: 'WEB_LOG', level: 'warn', message: 'mic track MUTED by system (another capture took the mic?)' });
                });
                track.addEventListener('unmute', function () {
                  post({ type: 'WEB_LOG', level: 'log', message: 'mic track unmuted' });
                });
                track.addEventListener('ended', function () {
                  post({ type: 'WEB_LOG', level: 'warn', message: 'mic track ENDED' });
                });
              });
              return stream;
            },
            function (err) {
              post({ type: 'WEB_LOG', level: 'error', message: 'getUserMedia FAILED: ' + err.name + ': ' + err.message });
              throw err;
            }
          );
        };
      }
    })();

    true;
  `;

  // ---------------------------------------------------------------
  // JS injected after the page loads (diagnostics + helpers)
  // ---------------------------------------------------------------
  const injectedJS = `
    (function () {
      // 1) Diagnostics: is the mic API available in this WebView?
      var micCheck = {
        type: 'MIC_CHECK',
        secure: window.isSecureContext,
        mediaDevices: !!navigator.mediaDevices,
        getUserMedia: typeof (navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        audioWorklet: typeof (window.AudioContext && window.AudioContext.prototype && window.AudioContext.prototype.audioWorklet) !== 'undefined' || 'audioWorklet' in (window.AudioContext ? AudioContext.prototype : {}),
        webAssembly: typeof WebAssembly,
        speechRecognition: !!(window.SpeechRecognition || window.webkitSpeechRecognition)
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
    if (!webViewLoaded) return;

    const appData = {
      fcmToken,
      micGranted,
      platform: 'ios-app',
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
    try {
      const data = JSON.parse(event.nativeEvent.data);

      switch (data.type) {
        case 'WEB_LOG':
          console.log(`[WEB ${data.level}]`, data.message);
          break;

        case 'MIC_CHECK':
          console.log('Microphone check:', data);
          if (!data.mediaDevices || data.getUserMedia !== 'function') {
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
    } catch (error) {
      console.log('WebView message:', event.nativeEvent.data);
    }
  };

  return (
    <WebView
      ref={webviewRef}
      source={{ uri: WEBSITE_URL }}
      style={{ flex: 1 }}
      injectedJavaScriptBeforeContentLoaded={injectedBeforeLoad}
      injectedJavaScript={injectedJS}
      javaScriptEnabled
      // TEMP while testing: never serve a cached copy of the website
      cacheEnabled={false}
      domStorageEnabled
      allowsInlineMediaPlayback
      // `false` / [] = no user tap needed for audio/video playback (TTS, chime)
      mediaPlaybackRequiresUserAction={false}
      allowsAirPlayForMediaPlayback={false}
      // iOS 15+: don't show a second popup for your own website
      mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
      // Keep the page alive when the keyboard / app state changes
      allowsBackForwardNavigationGestures={false}
      onLoadStart={() => {
        setWebViewLoaded(false);
        console.log('Website loading...');
      }}
      onLoadEnd={() => {
        console.log('Website loaded successfully');
        setWebViewLoaded(true);
      }}
      onMessage={handleWebViewMessage}
      onError={(event) => {
        console.log('WebView Error:', event.nativeEvent);
      }}
      onHttpError={(event) => {
        console.log('HTTP Error:', event.nativeEvent);
      }}
      onContentProcessDidTerminate={() => {
        // iOS kills the WebView process under memory pressure (the VAD/ONNX
        // models are heavy). Reload instead of showing a blank page.
        console.log('WebView process terminated, reloading');
        webviewRef.current?.reload();
      }}
    />
  );
}



//old

// import messaging from '@react-native-firebase/messaging';
// import { AudioModule } from 'expo-audio';
// import * as Device from 'expo-device';
// import * as Location from 'expo-location';
// import * as Notifications from 'expo-notifications';
// import { useCallback, useEffect, useRef, useState } from 'react';
// import { Alert, Linking } from 'react-native';
// import { WebView } from 'react-native-webview';

// const WEBSITE_URL = 'https://testcustomer.air2o.net/';

// // true  = ask for the microphone as soon as the app opens
// // false = ask only when the website sends { type: 'REQUEST_MIC' }
// const ASK_MIC_ON_START = true;

// // Show on-screen alerts for mic test results (useful in TestFlight).
// // Set to false before the final App Store release.
// const DEBUG_ALERTS = true;

// Notifications.setNotificationHandler({
//   handleNotification: async () => ({
//     shouldShowBanner: true,
//     shouldShowList: true,
//     shouldPlaySound: true,
//     shouldSetBadge: false,
//   }),
// });

// export default function App() {
//   const webviewRef = useRef(null);

//   const [location, setLocation] = useState(null);
//   const [fcmToken, setFcmToken] = useState('');
//   const [webViewLoaded, setWebViewLoaded] = useState(false);
//   const [micGranted, setMicGranted] = useState(false);

//   // ---------------------------------------------------------------
//   // MICROPHONE (native iOS / Android permission)
//   // ---------------------------------------------------------------
//   const requestMicPermission = useCallback(async () => {
//     try {
//       const current = await AudioModule.getRecordingPermissionsAsync();

//       if (current.granted) {
//         setMicGranted(true);
//         return true;
//       }

//       // Shows the iOS "Air2o Would Like to Access the Microphone" popup
//       const result = await AudioModule.requestRecordingPermissionsAsync();
//       setMicGranted(result.granted);

//       if (!result.granted && !result.canAskAgain) {
//         Alert.alert(
//           'Microphone needed',
//           'Microphone access is turned off. Please enable it in Settings to use voice features.',
//           [
//             { text: 'Open Settings', onPress: () => Linking.openSettings() },
//             { text: 'Cancel', style: 'cancel' },
//           ]
//         );
//       }

//       return result.granted;
//     } catch (error) {
//       console.log('Mic permission error:', error);
//       return false;
//     }
//   }, []);

//   useEffect(() => {
//     if (ASK_MIC_ON_START) {
//       requestMicPermission();
//     }
//   }, [requestMicPermission]);

//   // Tell the website the current mic permission state
//   const sendMicStatusToWebsite = useCallback((granted) => {
//     const script = `
//       (function () {
//         window.dispatchEvent(
//           new CustomEvent('micPermissionFromApp', {
//             detail: { granted: ${granted ? 'true' : 'false'} }
//           })
//         );
//       })();
//       true;
//     `;
//     webviewRef.current?.injectJavaScript(script);
//   }, []);

//   // ---------------------------------------------------------------
//   // LOCATION
//   // ---------------------------------------------------------------
//   useEffect(() => {
//     const getLocation = async () => {
//       try {
//         const { status } = await Location.requestForegroundPermissionsAsync();

//         if (status !== 'granted') {
//           Alert.alert('Location permission denied');
//           return;
//         }

//         const currentLocation = await Location.getCurrentPositionAsync({});
//         setLocation(currentLocation);
//         console.log('Location:', currentLocation.coords);
//       } catch (error) {
//         console.log('Location error:', error);
//       }
//     };

//     getLocation();
//   }, []);

//   // ---------------------------------------------------------------
//   // FCM
//   // ---------------------------------------------------------------
//   useEffect(() => {
//     registerForPushNotificationsAsync();

//     const unsubscribe = messaging().onMessage(async (remoteMessage) => {
//       console.log('Foreground notification:', remoteMessage);
//     });

//     return unsubscribe;
//   }, []);

//   async function registerForPushNotificationsAsync() {
//     try {
//       if (!Device.isDevice) {
//         Alert.alert('Must use a physical device');
//         return;
//       }

//       const { status: existingStatus } =
//         await Notifications.getPermissionsAsync();

//       let finalStatus = existingStatus;

//       if (existingStatus !== 'granted') {
//         const { status } = await Notifications.requestPermissionsAsync();
//         finalStatus = status;
//       }

//       if (finalStatus !== 'granted') {
//         Alert.alert('Notification permission denied');
//         return;
//       }

//       await messaging().registerDeviceForRemoteMessages();
//       await messaging().requestPermission();

//       const token = await messaging().getToken();
//       console.log('FCM TOKEN:', token);
//       setFcmToken(token);
//     } catch (error) {
//       console.log('FCM ERROR:', error);
//     }
//   }

//   // ---------------------------------------------------------------
//   // JS injected into the website (runs on every page load)
//   // ---------------------------------------------------------------
//   const injectedJS = `
//     (function () {
//       // 1) Diagnostics: is the mic API available in this WebView?
//       var micCheck = {
//         type: 'MIC_CHECK',
//         secure: window.isSecureContext,
//         mediaDevices: !!navigator.mediaDevices,
//         getUserMedia: typeof (navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
//       };
//       window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(micCheck));

//       // 2) Helpers your website can call
//       // Ask the native app to request mic permission:
//       //    window.requestNativeMic()
//       window.requestNativeMic = function () {
//         window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'REQUEST_MIC' }));
//       };

//       // Real test of getUserMedia. Call from a button tap:
//       //    window.testMic()
//       window.testMic = function () {
//         if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
//           window.ReactNativeWebView.postMessage(JSON.stringify({
//             type: 'MIC_RESULT', ok: false, error: 'mediaDevices undefined'
//           }));
//           return;
//         }
//         navigator.mediaDevices.getUserMedia({ audio: true })
//           .then(function (stream) {
//             stream.getTracks().forEach(function (t) { t.stop(); });
//             window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'MIC_RESULT', ok: true }));
//           })
//           .catch(function (e) {
//             window.ReactNativeWebView.postMessage(JSON.stringify({
//               type: 'MIC_RESULT', ok: false, error: e.name + ': ' + e.message
//             }));
//           });
//       };
//     })();

//     true;
//   `;

//   // ---------------------------------------------------------------
//   // SEND LOCATION + FCM TOKEN TO WEBSITE
//   // ---------------------------------------------------------------
//   useEffect(() => {
//     if (!webViewLoaded) return;

//     const appData = {
//       fcmToken,
//       micGranted,
//       location: {
//         latitude: location?.coords?.latitude ?? 0,
//         longitude: location?.coords?.longitude ?? 0,
//       },
//     };

//     const script = `
//       (function () {
//         const data = ${JSON.stringify(appData)};

//         window.fcmToken = data.fcmToken;

//         window.dispatchEvent(
//           new CustomEvent('locationFromApp', { detail: data.location })
//         );

//         window.dispatchEvent(
//           new CustomEvent('appDataFromNative', { detail: data })
//         );
//       })();

//       true;
//     `;

//     webviewRef.current?.injectJavaScript(script);
//   }, [webViewLoaded, location, fcmToken, micGranted]);

//   // ---------------------------------------------------------------
//   // RECEIVE MESSAGES FROM WEBSITE
//   // ---------------------------------------------------------------
//   const handleWebViewMessage = async (event) => {
//     try {
//       const data = JSON.parse(event.nativeEvent.data);

//       switch (data.type) {
//         case 'MIC_CHECK':
//           console.log('Microphone check:', data);
//           if (!data.mediaDevices || data.getUserMedia !== 'function') {
//             console.log('Microphone API is unavailable inside this WebView.');
//             if (DEBUG_ALERTS) {
//               Alert.alert('Mic API unavailable', JSON.stringify(data));
//             }
//           }
//           break;

//         case 'REQUEST_MIC': {
//           const granted = await requestMicPermission();
//           sendMicStatusToWebsite(granted);
//           break;
//         }

//         case 'MIC_RESULT':
//           console.log('Mic test result:', data);
//           if (DEBUG_ALERTS) {
//             Alert.alert(
//               'Mic test',
//               data.ok ? 'Granted ✅' : `Failed ❌\n${data.error}`
//             );
//           }
//           break;

//         default:
//           console.log('Message from website:', data);
//       }
//     } catch (error) {
//       console.log('WebView message:', event.nativeEvent.data);
//     }
//   };

//   return (
//     <WebView
//       ref={webviewRef}
//       source={{ uri: WEBSITE_URL }}
//       style={{ flex: 1 }}
//       injectedJavaScript={injectedJS}
//       javaScriptEnabled
//       domStorageEnabled
//       allowsInlineMediaPlayback
//       mediaPlaybackRequiresUserAction={false}
//       // iOS 15+: don't show a second popup for your own website
//       mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
//       onLoadStart={() => {
//         setWebViewLoaded(false);
//         console.log('Website loading...');
//       }}
//       onLoadEnd={() => {
//         console.log('Website loaded successfully');
//         setWebViewLoaded(true);
//       }}
//       onMessage={handleWebViewMessage}
//       onError={(event) => {
//         console.log('WebView Error:', event.nativeEvent);
//       }}
//       onHttpError={(event) => {
//         console.log('HTTP Error:', event.nativeEvent);
//       }}
//     />
//   );
// }