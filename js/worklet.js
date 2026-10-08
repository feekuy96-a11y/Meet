
// js/worklet.js - Prevents Background Throttling
class PulseProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.frames = 0;
    }
    process() {
        this.frames += 128; // Standard web audio block size
        // Pulse roughly every 80ms (sampleRate * 0.08)
        if (this.frames >= sampleRate * 0.08) {
            this.frames = 0;
            this.port.postMessage('pulse');
        }
        return true;
    }
}
registerProcessor('mn-pulse', PulseProcessor);
