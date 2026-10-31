// Pure gaze maths: landmarks -> features -> screen point. Shared by the
// offscreen tracker, the calibration page, the content script and unit tests.
(() => {
  // Fixed scales, not per-session std: dividing by a value that barely moved during
  // calibration would make the model explode the moment it does move.
  const SCALE = [5, 5, 2, 1.5, 15, 15]; // head ray x, y (cm); eye offset x, y (cm); eye-look signal x, y
  // Each screen axis only sees what can physically move it. With 14 dots a free fit
  // invents links, such as turning the head sideways moving the cursor vertically.
  const X_TERMS = [0, 1, 3, 5, 8]; // intercept, head x, eye x, eye x squared, look x
  const Y_TERMS = [0, 4, 6, 9]; // intercept, eye y, eye y squared, look y (head y is tied to head x)
  const MAX_PX_PER_CM = 150;
  const LOOK = {
    x: [['eyeLookOutLeft', 1], ['eyeLookInRight', 1], ['eyeLookInLeft', -1], ['eyeLookOutRight', -1]],
    y: [['eyeLookUpLeft', 1], ['eyeLookUpRight', 1], ['eyeLookDownLeft', -1], ['eyeLookDownRight', -1]],
  };
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
  // blendshapes: MediaPipe's own eye-direction scores, much better than the iris
  // position at telling up from down, where the eyelids hide most of the movement.
  function extractFeatures(landmarks, matrix, aspect, blendshapes = []) {
    const score = (name) => blendshapes.find((c) => c.categoryName === name)?.score ?? 0;
    const look = (axis) => LOOK[axis].reduce((sum, [name, sign]) => sum + sign * score(name), 0) / 2;
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
        look('x'),
        look('y'),
      ],
    };
  }

  // Where the gaze ray meets the screen plane, in camera-space cm. The webcam sits
  // in that plane, so the head's position and the ray share one scale: this is why
  // moving in the chair needs no training data. Calibration barely moves the head's
  // position, so a learned weight for it could never come out right.
  function geometry([ex, ey, yaw, pitch, tx, ty, tz, lookX = 0, lookY = 0]) {
    const distance = Math.max(-tz, MIN_DISTANCE_CM);
    return [
      tx + distance * Math.tan(yaw),
      ty - distance * Math.tan(pitch) / Math.cos(yaw),
      distance * ex, // the same eye rotation covers more screen from further away
      distance * ey,
      distance * lookX,
      distance * lookY,
    ];
  }

  function expand(raw, mean) {
    const z = geometry(raw).map((v, i) => (v - (mean[i] ?? 0)) / SCALE[i]);
    return [1, z[0], z[1], z[2], z[3], z[2] * z[2], z[3] * z[3], z[2] * z[3], z[4], z[5]];
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

  function ridge(X, y, terms) {
    const d = terms.length;
    const lambda = RIDGE * X.length;
    const A = Array.from({ length: d }, () => new Array(d).fill(0));
    const b = new Array(d).fill(0);
    for (let s = 0; s < X.length; s++) {
      for (let i = 0; i < d; i++) {
        b[i] += X[s][terms[i]] * y[s];
        for (let j = 0; j < d; j++) A[i][j] += X[s][terms[i]] * X[s][terms[j]];
      }
    }
    for (let i = 1; i < d; i++) A[i][i] += lambda; // never penalise the intercept
    const solved = solve(A, b);
    const weights = new Array(X[0].length).fill(0);
    terms.forEach((term, i) => { weights[term] = solved[i]; });
    return weights;
  }

  function fitOnce(samples) {
    const derived = samples.map((s) => geometry(s.f));
    const mean = SCALE.map((_, i) => derived.reduce((a, d) => a + d[i], 0) / derived.length);
    const X = samples.map((s) => expand(s.f, mean));
    const wx = ridge(X, samples.map((s) => s.x), X_TERMS);
    // Pixels are square, so a centimetre of head ray moves the cursor as far vertically
    // as horizontally. Height is poorly seen by a webcam, so it borrows that scale, and
    // up is always up: a higher ray means a higher point on the screen.
    const pxPerCm = Math.min(Math.abs(wx[1]) / SCALE[0], MAX_PX_PER_CM);
    const headY = -pxPerCm * SCALE[1];
    const wy = ridge(X, samples.map((s, i) => s.y - headY * X[i][2]), Y_TERMS);
    wy[2] = headY;
    return { mean, wx, wy };
  }

  function predict(model, raw) {
    const row = expand(raw, model.mean);
    return {
      x: row.reduce((a, v, i) => a + v * (model.wx[i] ?? 0), 0),
      y: row.reduce((a, v, i) => a + v * (model.wy[i] ?? 0), 0),
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
  function crossValidate(samples, keep = () => true, measure = residual) {
    const points = [...new Set(samples.filter(keep).map((s) => s.point))];
    let total = 0, count = 0;
    for (const point of points) {
      const test = samples.filter((s) => s.point === point);
      const { model } = fit(samples.filter((s) => s.point !== point));
      for (const s of test) { total += measure(model, s); count++; }
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

  // A quick flick of the head and back. Only out-and-back counts: a slow turn, or a
  // turn that stays, is the user looking somewhere. Fires on the way back, so the
  // whole motion has been seen before deciding. Axis values are in units of threshold.
  function createHeadFlick({
    yawThreshold = 0.06, pitchThreshold = 0.045, riseMs = 260, returnMs = 600,
    cooldownMs = 800, dominance = 1.8, baselineTauMs = 700, deadZone = 0.35, gapMs = 500,
  } = {}) {
    let base = null, phase = 'idle', startAt = 0, peakAt = 0, peak = null;
    let cooldownUntil = 0, lastFrame = 0, history = [];
    const middle = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const rebase = (yaw, pitch) => { base = { yaw, pitch }; phase = 'idle'; };

    return (rawYaw, rawPitch, t) => {
      const gap = t - lastFrame;
      lastFrame = t;
      if (!base || gap > gapMs) history = [];
      history = [...history.slice(-2), [rawYaw, rawPitch]]; // a median drops one-frame spikes
      const yaw = middle(history.map((h) => h[0]));
      const pitch = middle(history.map((h) => h[1]));
      if (!base || gap > gapMs) { rebase(yaw, pitch); return { flick: null, moving: false }; }

      const y = (yaw - base.yaw) / yawThreshold;
      const p = (pitch - base.pitch) / pitchThreshold;
      const size = Math.max(Math.abs(y), Math.abs(p));
      let flick = null;

      if (phase === 'idle') {
        if (size > deadZone && t >= cooldownUntil) {
          phase = 'rise';
          startAt = t;
        } else {
          const a = 1 - Math.exp(-gap / baselineTauMs);
          base = { yaw: base.yaw + (yaw - base.yaw) * a, pitch: base.pitch + (pitch - base.pitch) * a };
        }
      } else if (phase === 'rise') {
        if (size >= 1 && t - startAt <= riseMs) {
          phase = 'peak';
          peak = { y, p, size };
          peakAt = t;
        } else if (t - startAt > riseMs) {
          rebase(yaw, pitch); // too slow to be a flick
        } else if (size <= deadZone) {
          phase = 'idle';
        }
      } else if (phase === 'peak') {
        if (size > peak.size) peak = { y, p, size };
        if (t - peakAt > returnMs) {
          rebase(yaw, pitch); // it stayed there: a turn, not a flick
        } else if (size <= peak.size * 0.5) {
          const ay = Math.abs(peak.y), ap = Math.abs(peak.p);
          if (Math.max(ay, ap) >= Math.min(ay, ap) * dominance) {
            flick = ay > ap ? (peak.y > 0 ? 'yaw+' : 'yaw-') : (peak.p > 0 ? 'pitch+' : 'pitch-');
          }
          cooldownUntil = t + cooldownMs;
          phase = 'idle';
        }
      }
      return { flick, moving: phase !== 'idle' };
    };
  }

  // The next item from `from` in a direction, inside a 45 degree cone. Staying in the
  // same row or column counts for more than being close, as people expect of arrows.
  function neighbourIn(direction, from, rects) {
    const cx = (r) => (r.left + r.right) / 2, cy = (r) => (r.top + r.bottom) / 2;
    const horizontal = direction === 'left' || direction === 'right';
    const sign = direction === 'right' || direction === 'down' ? 1 : -1;
    let best = -1, bestScore = Infinity;
    rects.forEach((r, i) => {
      if (r === from) return;
      const along = (horizontal ? cx(r) - cx(from) : cy(r) - cy(from)) * sign;
      const across = Math.abs(horizontal ? cy(r) - cy(from) : cx(r) - cx(from));
      if (along <= 0 || across > along) return;
      const score = along + across * 2;
      if (score < bestScore) { best = i; bestScore = score; }
    });
    return best;
  }

  // Head mode ignores the eyes, so it still works when they can't be seen well.
  const headOnly = (f) => [0, 0, ...f.slice(2, 7)];

  const errorX = (model, s) => Math.abs(predict(model, s.f).x - s.x);
  const errorY = (model, s) => Math.abs(predict(model, s.f).y - s.y);

  globalThis.GazeModel = { errorX, errorY, extractFeatures, fit, predict, crossValidate, createFilter, pickTarget, createHoldGesture, createHeadFlick, neighbourIn, headOnly };
})();
