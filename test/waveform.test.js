import assert from "node:assert/strict";
import { test } from "node:test";

import { computeWaveformPeaks, sliceWaveformPeaks } from "../src/waveform.js";

test("computeWaveformPeaks returns normalized peak amplitude per bar", () => {
  const samples = Float32Array.from([0, 0.2, -0.4, 0, 0.6, -0.8, 0.1, -0.2]);

  assert.deepEqual(computeWaveformPeaks(samples, 4), [0.25, 0.5, 1, 0.25]);
});

test("computeWaveformPeaks returns silence for empty input", () => {
  assert.deepEqual(computeWaveformPeaks(new Float32Array(), 3), [0, 0, 0]);
});

test("sliceWaveformPeaks extracts passage peaks from cached full-footage peaks", () => {
  assert.deepEqual(
    sliceWaveformPeaks({
      peaks: [0, 0.1, 0.2, 0.4, 0.8, 0.6, 0.3, 0.1],
      duration: 4,
      start: 1,
      end: 3,
      bars: 4,
    }),
    [0.25, 0.5, 1, 0.75],
  );
});
