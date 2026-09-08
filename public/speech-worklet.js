// AudioContext supplies mono audio at 24 kHz. Send 80 ms PCM16 frames.
class SpeechCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'stop') {
        this.flush();
        this.stopped = true;
        this.port.postMessage('stopped');
      }
    };
  }
  flush() {
    if (!this.samples.length) return;
    const buffer = new ArrayBuffer(this.samples.length * 2);
    const view = new DataView(buffer);
    this.samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
    this.samples = [];
    this.port.postMessage(buffer, [buffer]);
  }
  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (channel) for (const value of channel) {
      const clipped = Math.max(-1, Math.min(1, value));
      this.samples.push(Math.round(clipped * (clipped < 0 ? 32768 : 32767)));
      if (this.samples.length === 1920) this.flush();
    }
    return true;
  }
}
registerProcessor('speech-capture', SpeechCapture);
