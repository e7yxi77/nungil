// Pure gaze maths: landmarks -> features -> screen point. Shared by the
// offscreen tracker, the calibration page, the content script and unit tests.
(() => {
  // Fixed scales, not per-session std: dividing by a value that barely moved during
  // calibration would make the model explode the moment it does move.
  const SCALE = [5, 5, 2, 1.5]; // head ray x, y (cm); eye offset x, y (cm)
  const MIN_DISTANCE_CM = 10;
  const RIDGE = 0.01;
  const BLINK_RATIO = 0.12;
  const MOUTH_OPEN_RATIO = 0.45;

  function eyeMetrics(lm, aspect, left, right, top, bottom, iris) {
    const p = (i) => ({ x: lm[i].x, y: lm[i].y * aspect });
    const a = p(left), b = p(right), t = p(top), d = p(bottom);
    // Averaging the iris centre and its four rim points steadies it a lot:
    // an iris is only a few pixels wide on a webcam.
    const ring = [0, 1, 2, 3, 4].map((i) => p(iris + i));
    const c = { x: ring.reduce((s, q) => s + q.x, 0) / 5, y: ring.reduce((s, q) => s + q.y, 0) / 5 };
    const dx = b.x - a.x, dy = b.y - a.y;
    const width = Math.hypot(dx, dy);
    const ux = dx / width, uy = dy / width;
    const ox = c.x - (a.x + b.x) / 2, oy = c.y - (a.y + b.y) / 2;
    return {
      x: (ox * ux + oy * uy) / width,
      y: (-ox * uy + oy * ux) / width,
      open: Math.hypot(t.x - d.x, t.y - d.y) / width,
    };
  }

  // landmarks: MediaPipe 478-point face mesh. matrix: 16 numbers, column-major.
  function extractFeatures(landmarks, matrix, aspect) {
    const r = eyeMetrics(landmarks, aspect, 33, 133, 159, 145, 468);
    const l = eyeMetrics(landmarks, aspect, 362, 263, 386, 374, 473);
    const open = (r.open + l.open) / 2;
    const mouthWidth = Math.hypot(landmarks[78].x - landmarks[308].x, (landmarks[78].y - landmarks[308].y) * aspect);
    const mouthGap = Math.hypot(landmarks[13].x - landmarks[14].x, (landmarks[13].y - landmarks[14].y) * aspect);
    return {
      blink: open < BLINK_RATIO,
      open,
      mouthOpen: mouthWidth > 0 && mouthGap / mouthWidth > MOUTH_OPEN_RATIO,
      features: [
        (r.x + l.x) / 2,
        (r.y + l.y) / 2,
        Math.atan2(matrix[8], matrix[10]),
        Math.asin(Math.max(-1, Math.min(1, -matrix[9]))),
        matrix[12],
        matrix[13],
        matrix[14],
      ],
    };
  }

  // Where the gaze ray meets the screen plane, in camera-space cm. The webcam sits
  // in that plane, so the head's position and the ray share one scale: this is why
  // moving in the chair needs no training data. Calibration barely moves the head's
  // position, so a learned weight for it could never come out right.
  function geometry([ex, ey, yaw, pitch, tx, ty, tz]) {
    const distance = Math.max(-tz, MIN_DISTANCE_CM);
    return [
      tx + distance * Math.tan(yaw),
      ty - distance * Math.tan(pitch) / Math.cos(yaw),
      distance * ex, // the same eye rotation covers more screen from further away
      distance * ey,
    ];
  }

  function expand(raw, mean) {
    const z = geometry(raw).map((v, i) => (v - mean[i]) / SCALE[i]);
    return [1, ...z, z[2] * z[2], z[3] * z[3], z[2] * z[3]];
  }

  function solve(A, b) {
    const n = b.length;
    const m = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let pivot = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
      [m[c], m[pivot]] = [m[pivot], m[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = m[r][c] / m[c][c];
        for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
      }
    }
    return m.map((row, i) => row[n] / row[i]);
  }

  function ridge(X, y) {
    const d = X[0].length;
    const lambda = RIDGE * X.length;
    const A = Array.from({ length: d }, () => new Array(d).fill(0));
    const b = new Array(d).fill(0);
    for (let s = 0; s < X.length; s++) {
      for (let i = 0; i < d; i++) {
        b[i] += X[s][i] * y[s];
        for (let j = 0; j < d; j++) A[i][j] += X[s][i] * X[s][j];
      }
    }
    for (let i = 1; i < d; i++) A[i][i] += lambda; // never penalise the intercept
    return solve(A, b);
  }

  function fitOnce(samples) {
    const derived = samples.map((s) => geometry(s.f));
    const mean = SCALE.map((_, i) => derived.reduce((a, d) => a + d[i], 0) / derived.length);
    const X = samples.map((s) => expand(s.f, mean));
    return { mean, wx: ridge(X, samples.map((s) => s.x)), wy: ridge(X, samples.map((s) => s.y)) };
  }

  function predict(model, raw) {
    const row = expand(raw, model.mean);
    return {
      x: row.reduce((a, v, i) => a + v * model.wx[i], 0),
      y: row.reduce((a, v, i) => a + v * model.wy[i], 0),
    };
  }

  const residual = (model, s) => {
    const p = predict(model, s.f);
    return Math.hypot(p.x - s.x, p.y - s.y);
  };

  // Fit, drop the worst 15% of each dot's frames (saccades, half-blinks), refit.
  // Per dot, because a global cut throws out whole dots the first fit found hard,
  // which are the head-turn dots: the model would then never learn the head.
  function fit(samples) {
    const first = fitOnce(samples);
    const kept = [...new Set(samples.map((s) => s.point))].flatMap((point) => {
      const own = samples.filter((s) => s.point === point);
      return own
        .map((s) => [residual(first, s), s])
        .sort((a, b) => a[0] - b[0])
        .slice(0, Math.ceil(own.length * 0.85))
        .map(([, s]) => s);
    });
    return { model: fitOnce(kept), kept };
  }

  // Leave-one-point-out: honest error on a screen position the model never saw.
  function crossValidate(samples, keep = () => true) {
    const points = [...new Set(samples.filter(keep).map((s) => s.point))];
    let total = 0, count = 0;
    for (const point of points) {
      const test = samples.filter((s) => s.point === point);
      const { model } = fit(samples.filter((s) => s.point !== point));
      for (const s of test) { total += residual(model, s); count++; }
    }
    return count ? total / count : Infinity;
  }

  // One Euro filter: steady when gaze rests, responsive when it jumps.
  function createFilter({ minCutoff = 0.3, beta = 0.008, dCutoff = 1 } = {}) {
    const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    let last = null;
    return (x, y, t) => {
      if (!last || t - last.t > 1000) {
        last = { x, y, dx: 0, dy: 0, t };
        return { x, y };
      }
      const dt = Math.max((t - last.t) / 1000, 1e-3);
      const ad = alpha(dCutoff, dt);
      const dx = ad * (x - last.x) / dt + (1 - ad) * last.dx;
      const dy = ad * (y - last.y) / dt + (1 - ad) * last.dy;
      const a = alpha(minCutoff + beta * Math.hypot(dx, dy), dt);
      last = { x: a * x + (1 - a) * last.x, y: a * y + (1 - a) * last.y, dx, dy, t };
      return { x: last.x, y: last.y };
    };
  }

  // Index of the nearest rect within radius; a point inside a rect is distance 0
  // and nested rects tie-break to the smallest (the most specific element).
  function pickTarget(rects, point, radius) {
    let best = -1, bestDist = Infinity, bestArea = Infinity;
    rects.forEach((r, i) => {
      const dx = Math.max(r.left - point.x, 0, point.x - r.right);
      const dy = Math.max(r.top - point.y, 0, point.y - r.bottom);
      const dist = Math.hypot(dx, dy);
      const area = (r.right - r.left) * (r.bottom - r.top);
      if (dist > radius) return;
      if (dist < bestDist || (dist === bestDist && area < bestArea)) {
        best = i; bestDist = dist; bestArea = area;
      }
    });
    return best;
  }

  // Fires when a condition has held for holdMs, then every repeatMs while it still holds.
  function createHoldGesture(holdMs, { gapMs = 500, repeatMs = Infinity } = {}) {
    let since = null, nextAt = 0, lastFrame = 0;
    return (active, t) => {
      if (t - lastFrame > gapMs) since = null;
      lastFrame = t;
      if (!active) { since = null; return false; }
      if (since === null) { since = t; nextAt = t + holdMs; }
      if (t < nextAt) return false;
      nextAt = t + repeatMs;
      return true;
    };
  }

  // Head mode ignores the eyes, so it still works when they can't be seen well.
  const headOnly = (f) => [0, 0, ...f.slice(2)];

  globalThis.GazeModel = { extractFeatures, fit, predict, crossValidate, createFilter, pickTarget, createHoldGesture, headOnly };
})();
