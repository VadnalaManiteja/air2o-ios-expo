import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { WebView } from 'react-native-webview';

export default function App() {
  const webviewRef = useRef(null);
  const [location, setLocation] = useState(null);

  useEffect(() => {
    const getLocation = async () => {
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission to access location was denied');
        return;
      }

      let location = await Location.getCurrentPositionAsync({});
      setLocation(location);
    };

    getLocation();
  }, []);

  const injectLocationJS = location
    ? `
        window.dispatchEvent(new CustomEvent('locationFromApp', {
          detail: {
            latitude: ${location.coords.latitude},
            longitude: ${location.coords.longitude}
          }
        }));
      `
    : '';

  return (
    <WebView
      ref={webviewRef}
      source={{ uri: 'https://customer.air2o.net/' }}
      style={{ flex: 1 }}
      injectedJavaScript={injectLocationJS}
      javaScriptEnabled={true}
    />
  );
}