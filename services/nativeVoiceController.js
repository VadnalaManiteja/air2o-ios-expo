/** One recognizer owns the microphone. A replacement waits for the old end event. */
export class NativeVoiceController {
  constructor(recognizer, emit, supportsWakeRecognition = () => false) {
    this.recognizer = recognizer;
    this.emit = emit;
    this.supportsWakeRecognition = supportsWakeRecognition;
    this.active = null;
    this.pendingRequestId = null;
    this.generation = 0;
    this.foreground = true;
    this.requestingPermission = false;
    this.waiters = [];
    this.listeners = ['start', 'result', 'error', 'end', 'volumechange'].map(name =>
      recognizer.addListener(name, event => this.onEvent(name, event)));
  }

  onEvent(name, event) {
    const session = this.active;
    if (!session) return;
    if (name === 'end') {
      this.active = null;
      // Restore response playback routing only after native capture releases.
      try { this.recognizer.setCategoryIOS({ category: 'playback', categoryOptions: [], mode: 'default' }); } catch { /* surfaced on next playback/capture */ }
      this.waiters.splice(0).forEach(resolve => resolve());
    }
    if (!session.cancelled) {
      this.emit({ ...event, event: name, requestId: session.requestId, mode: session.mode });
    }
  }

  async release() {
    if (!this.active) return;
    const shouldAbort = !this.active.cancelled;
    this.active.cancelled = true;
    const ended = new Promise(resolve => this.waiters.push(resolve));
    if (shouldAbort) this.recognizer.abort();
    let timer;
    try {
      await Promise.race([ended, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Microphone is still stopping. Please try again.')), 4000);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  async handle(command) {
    const { action, requestId, mode } = command;
    if (action === 'stop') {
      if (this.active?.requestId === requestId) this.recognizer.stop();
      else if (this.pendingRequestId === requestId) {
        ++this.generation;
        this.pendingRequestId = null;
        this.emit({ event: 'end', requestId, mode });
      }
      return;
    }
    if (action === 'cancel') {
      if (this.active?.requestId === requestId || this.pendingRequestId === requestId || requestId === '*') {
        ++this.generation;
        this.pendingRequestId = null;
        await this.release().catch(error => this.emit({ event: 'error', requestId, mode, error: 'native-stop', message: error.message }));
      }
      return;
    }
    if (action !== 'start' || !['wake', 'conversation', 'dictation'].includes(mode)) return;
    const generation = ++this.generation;
    this.pendingRequestId = requestId;
    try {
      await this.release();
      if (!this.foreground || generation !== this.generation) return;
      this.requestingPermission = true;
      let permission;
      try { permission = await this.recognizer.requestPermissionsAsync(); }
      finally { this.requestingPermission = false; }
      if (generation !== this.generation || !this.foreground) return;
      if (!permission.granted) throw new Error('Allow Microphone and Speech Recognition in iPhone Settings.');
      if (!this.recognizer.isRecognitionAvailable()) throw new Error('Speech recognition is unavailable. Enable Siri & Dictation in Settings.');
      if (mode === 'wake' && !this.supportsWakeRecognition('en-US')) {
        throw new Error('On-device wake phrase recognition is unavailable on this iPhone. Tap the mic to talk.');
      }
      this.active = { requestId, mode, cancelled: false };
      this.pendingRequestId = null;
      this.recognizer.start({
        lang: mode === 'wake' ? 'en-US' : command.lang || 'en-US',
        interimResults: true,
        continuous: mode === 'wake',
        requiresOnDeviceRecognition: mode === 'wake',
        contextualStrings: ['Hey AIRA', 'AIRA', 'Air2o'],
        iosTaskHint: mode === 'wake' ? 'search' : 'dictation',
        iosCategory: { category: 'playAndRecord', categoryOptions: ['defaultToSpeaker', 'allowBluetooth'], mode: 'measurement' },
        volumeChangeEventOptions: { enabled: true, intervalMillis: 150 },
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.pendingRequestId = null;
      this.emit({ event: 'error', requestId, mode, error: 'native-start', message: error.message });
      // A synchronous start failure has no native end event.
      if (this.active?.requestId === requestId) this.active = null;
      this.emit({ event: 'end', requestId, mode });
    }
  }

  setAppState(state) {
    // Permission sheets cause inactive before recording has begun.
    if (state === 'inactive' && this.requestingPermission) return false;
    this.setForeground(state === 'active');
    return true;
  }

  setForeground(foreground) {
    this.foreground = foreground;
    if (!foreground) {
      ++this.generation;
      this.pendingRequestId = null;
      const session = this.active;
      if (session && !session.cancelled) this.emit({ event: 'interrupted', requestId: session.requestId, mode: session.mode });
      void this.release().catch(() => {});
    }
  }

  dispose() {
    ++this.generation;
    this.listeners.forEach(listener => listener.remove());
    this.recognizer.abort();
    this.active = null;
    this.waiters.splice(0).forEach(resolve => resolve());
  }
}
