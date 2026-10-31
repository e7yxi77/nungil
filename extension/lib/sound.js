// Non-verbal control for people who can't form clear words: a short pop and a
// sustained hum, told apart by loudness envelope alone. Speech would trigger it
// too, so the tracker never runs this alongside speech recognition.
(() => {
  function createSoundDetector({ popMaxMs = 200, humMinMs = 600, humRepeatMs = 800, minLevel = 0.02, floorRatio = 4 } = {}) {
    let floor = minLevel / floorRatio;
    let startedAt = null, lastLoud = 0, lastHum = 0;
    return (level, t) => {
      const loud = level > Math.max(floor * floorRatio, minLevel);
      if (!loud) floor = floor * 0.98 + level * 0.02;
      if (loud) {
        if (startedAt === null) { startedAt = t; lastHum = 0; }
        lastLoud = t;
        if (t - startedAt >= humMinMs && t - lastHum >= humRepeatMs) {
          lastHum = t;
          return 'hum';
        }
        return null;
      }
      if (startedAt === null || t - lastLoud < 100) return null;
      const duration = lastLoud - startedAt;
      const hummed = lastHum > 0;
      startedAt = null;
      return !hummed && duration <= popMaxMs ? 'pop' : null;
    };
  }

  globalThis.NungilSound = { createSoundDetector };
})();
