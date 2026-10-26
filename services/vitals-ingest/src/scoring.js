// Early-warning score for one set of vital signs, modelled on the UK NEWS2 chart.
//
// DEMONSTRATION ONLY: CareSignal uses synthetic data and is not a medical device.
// The thresholds follow the public NEWS2 chart (SpO2 scale 1, without consciousness level
// and supplemental oxygen, which the simulated devices do not report).

// bands: [upperInclusiveLimit, points]; the last limit is Infinity
function band(value, bands) {
  for (const [limit, points] of bands) if (value <= limit) return points;
  throw new Error("unreachable");
}

function score(v) {
  const parts = {
    respiratory_rate: band(v.respiratory_rate, [[8, 3], [11, 1], [20, 0], [24, 2], [Infinity, 3]]),
    spo2: band(v.spo2, [[91, 3], [93, 2], [95, 1], [Infinity, 0]]),
    systolic_bp: band(v.systolic_bp, [[90, 3], [100, 2], [110, 1], [219, 0], [Infinity, 3]]),
    heart_rate: band(v.heart_rate, [[40, 3], [50, 1], [90, 0], [110, 1], [130, 2], [Infinity, 3]]),
    temperature: band(Math.round(v.temperature * 10) / 10, [[35.0, 3], [36.0, 1], [38.0, 0], [39.0, 1], [Infinity, 2]]),
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  let risk = "low";
  if (total >= 7) risk = "high";
  else if (total >= 5 || Object.values(parts).includes(3)) risk = "medium";
  return { score: total, risk, parts };
}

module.exports = { score };
