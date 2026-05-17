export function createRenderEtaEstimator({
  smoothingWindowSeconds = 12,
  minElapsedSeconds = 5,
  minSpeedSamples = 3,
  now = () => Date.now(),
} = {}) {
  let firstAt = null;
  let previousAt = null;
  let previousOutTime = 0;
  let smoothedSpeed = 0;
  let speedSamples = 0;

  return {
    update({ at = now(), outTime = 0, expectedDuration = 0 } = {}) {
      const sampleAt = Number(at);
      const encodedSeconds = Math.max(0, Number(outTime) || 0);
      const duration = Math.max(0, Number(expectedDuration) || 0);
      if (firstAt === null) {
        firstAt = sampleAt;
      }

      if (duration > 0 && encodedSeconds >= duration) {
        previousAt = sampleAt;
        previousOutTime = encodedSeconds;
        return { estimating: false, etaSeconds: 0, roundedEtaSeconds: 0, speed: smoothedSpeed };
      }

      if (previousAt !== null && sampleAt > previousAt && encodedSeconds > previousOutTime) {
        const deltaSeconds = (sampleAt - previousAt) / 1000;
        const instantSpeed = (encodedSeconds - previousOutTime) / deltaSeconds;
        if (Number.isFinite(instantSpeed) && instantSpeed > 0) {
          const alpha = 1 - Math.exp(-deltaSeconds / smoothingWindowSeconds);
          smoothedSpeed = smoothedSpeed > 0 ? smoothedSpeed + alpha * (instantSpeed - smoothedSpeed) : instantSpeed;
          speedSamples += 1;
        }
      }

      previousAt = sampleAt;
      previousOutTime = encodedSeconds;

      const elapsedSeconds = firstAt === null ? 0 : (sampleAt - firstAt) / 1000;
      if (elapsedSeconds < minElapsedSeconds || speedSamples < minSpeedSamples || !(smoothedSpeed > 0)) {
        return { estimating: true, etaSeconds: 0, roundedEtaSeconds: 0, speed: smoothedSpeed };
      }

      const etaSeconds = Math.max(0, (duration - encodedSeconds) / smoothedSpeed);
      return {
        estimating: false,
        etaSeconds,
        roundedEtaSeconds: roundEtaSeconds(etaSeconds),
        speed: smoothedSpeed,
      };
    },
  };
}

export function roundEtaSeconds(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value < 120) {
    return Math.round(value / 5) * 5;
  }
  if (value < 600) {
    return Math.round(value / 15) * 15;
  }
  return Math.round(value / 60) * 60;
}
