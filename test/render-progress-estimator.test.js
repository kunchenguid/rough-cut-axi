import assert from "node:assert/strict";
import { test } from "node:test";

import { createRenderEtaEstimator, roundEtaSeconds } from "../src/render-progress-estimator.js";

test("render ETA estimator waits for enough samples before showing an ETA", () => {
  const estimator = createRenderEtaEstimator({ minElapsedSeconds: 5, minSpeedSamples: 3 });

  assert.equal(estimator.update({ at: 0, outTime: 0, expectedDuration: 100 }).estimating, true);
  assert.equal(estimator.update({ at: 2000, outTime: 1, expectedDuration: 100 }).estimating, true);
  assert.equal(estimator.update({ at: 4000, outTime: 2, expectedDuration: 100 }).estimating, true);

  const estimate = estimator.update({ at: 6000, outTime: 3, expectedDuration: 100 });

  assert.equal(estimate.estimating, false);
  assert.equal(estimate.roundedEtaSeconds, 195);
});

test("render ETA estimator smooths and rounds noisy progress ticks", () => {
  const estimator = createRenderEtaEstimator({ minElapsedSeconds: 5, minSpeedSamples: 3 });

  estimator.update({ at: 0, outTime: 0, expectedDuration: 100 });
  estimator.update({ at: 5000, outTime: 2.5, expectedDuration: 100 });
  estimator.update({ at: 10000, outTime: 5, expectedDuration: 100 });
  const firstEstimate = estimator.update({ at: 15000, outTime: 7.5, expectedDuration: 100 });
  const secondEstimate = estimator.update({ at: 16000, outTime: 8.1, expectedDuration: 100 });
  const thirdEstimate = estimator.update({ at: 17000, outTime: 8.8, expectedDuration: 100 });

  assert.equal(firstEstimate.roundedEtaSeconds, 180);
  assert.equal(secondEstimate.roundedEtaSeconds, 180);
  assert.equal(thirdEstimate.roundedEtaSeconds, 180);
});

test("roundEtaSeconds uses coarse buckets", () => {
  assert.equal(roundEtaSeconds(92), 90);
  assert.equal(roundEtaSeconds(184), 180);
  assert.equal(roundEtaSeconds(653), 660);
});
