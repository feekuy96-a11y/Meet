// MediaRecorder chunks are persisted immediately; the browser may still suspend
// recording in the background. No silent audio or worklet can guarantee otherwise.
export class AudioEngine {
  constructor() {
    this.stream = null;
    this.ac = null;
    this.an = null;
    this.recorder = null;
    this.pending = Promise.resolve();
    this.recovery = [];
  }
  async start(writeChunk, onFailure, onEnded) {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder)
      throw new Error('เบราว์เซอร์ไม่รองรับบันทึกเสียง ใช้ Chrome/Edge และ HTTPS หรือ localhost');
    this.recovery = [];
    this.pending = Promise.resolve();
    this.failure = null;
    this.recorder = null;
    this.stopEvent = null;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      let mimeType = [
        'audio/webm;codecs=opus',
        'audio/mp4',
        'audio/ogg;codecs=opus',
        'audio/webm'
      ].find((t) => MediaRecorder.isTypeSupported(t));
      this.recorder = new MediaRecorder(this.stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 24000
      });
      let seq = 0;
      this.recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        const chunk = { seq: seq++, blob: event.data };
        this.pending = this.pending.then(async () => {
          try {
            await writeChunk(chunk);
          } catch (error) {
            this.recovery.push(chunk);
            if (!this.failure) {
              this.failure = error;
              onFailure(error);
            }
          }
        });
      };
      this.recorder.onerror = (event) =>
        onFailure(event.error || new Error('ตัวบันทึกเสียงขัดข้อง'));
      this.stream.getAudioTracks().forEach((track) => track.addEventListener('ended', onEnded));
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (AudioContextClass) {
        try {
          this.ac = new AudioContextClass();
          await this.ac.resume();
          this.an = this.ac.createAnalyser();
          this.an.fftSize = 2048;
          this.ac.createMediaStreamSource(this.stream).connect(this.an);
        } catch {
          this.an = null;
        } // Recording does not depend on the meter.
      }
      this.recorder.start(2000);
      this.stopEvent = new Promise((resolve) =>
        this.recorder.addEventListener('stop', resolve, { once: true })
      );
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }
  pause() {
    if (this.recorder?.state === 'recording') {
      this.recorder.requestData();
      this.recorder.pause();
    }
  }
  resume() {
    if (this.recorder?.state === 'paused') this.recorder.resume();
  }
  async stop() {
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
      if (this.stopEvent) await this.stopEvent;
      await this.pending;
      return this.recovery;
    } finally {
      await this.dispose();
    }
  }
  async dispose() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.ac && this.ac.state !== 'closed') await this.ac.close().catch(() => {});
    this.ac = null;
    this.an = null;
  }
}
