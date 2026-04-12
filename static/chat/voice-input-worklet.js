"use strict";

class RemoteLabVoiceInputProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const configuredChunkFrames = Number(options?.processorOptions?.chunkFrames);
    this.chunkFrames = Number.isFinite(configuredChunkFrames)
      ? Math.max(256, Math.min(8192, Math.round(configuredChunkFrames)))
      : 2048;
    this.pendingSamples = new Float32Array(this.chunkFrames);
    this.pendingLength = 0;
    this.pendingSquareSum = 0;
    this.pendingSquareCount = 0;

    this.port.onmessage = (event) => {
      const payload = event?.data;
      if (!payload || typeof payload !== "object") return;
      if (payload.type === "flush") {
        this.flushPending(payload.requestId);
      }
    };
  }

  pushSamples(inputSamples) {
    let offset = 0;
    while (offset < inputSamples.length) {
      const writable = Math.min(this.chunkFrames - this.pendingLength, inputSamples.length - offset);
      const slice = inputSamples.subarray(offset, offset + writable);
      this.pendingSamples.set(slice, this.pendingLength);
      for (let index = 0; index < slice.length; index += 1) {
        const sample = slice[index];
        this.pendingSquareSum += sample * sample;
      }
      this.pendingSquareCount += slice.length;
      this.pendingLength += slice.length;
      offset += writable;
      if (this.pendingLength >= this.chunkFrames) {
        this.flushPending(0);
      }
    }
  }

  flushPending(requestId = 0) {
    if (this.pendingLength > 0) {
      const packet = new Float32Array(this.pendingLength);
      packet.set(this.pendingSamples.subarray(0, this.pendingLength));
      const level = this.pendingSquareCount > 0
        ? Math.sqrt(this.pendingSquareSum / this.pendingSquareCount)
        : 0;
      this.port.postMessage(
        {
          type: "audio",
          samples: packet,
          sampleRate,
          level,
        },
        [packet.buffer],
      );
      this.pendingLength = 0;
      this.pendingSquareSum = 0;
      this.pendingSquareCount = 0;
    }

    if (requestId) {
      this.port.postMessage({
        type: "flushed",
        requestId,
      });
    }
  }

  process(inputs) {
    const inputSamples = inputs?.[0]?.[0];
    if (!(inputSamples instanceof Float32Array) || inputSamples.length === 0) {
      return true;
    }
    this.pushSamples(inputSamples);
    return true;
  }
}

registerProcessor("remotelab-voice-input-processor", RemoteLabVoiceInputProcessor);
