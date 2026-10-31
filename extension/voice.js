// Continuous speech recognition. Loaded by the offscreen document, and by
// voice.html when offscreen recognition is refused.
(() => {
  const params = new URLSearchParams(location.search);
  if (params.get('sound') === '1') return; // sound control replaces speech
  const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  const FATAL = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported']);
  const IGNORED = new Set(['no-speech', 'aborted']);
  let stopped = false;
  let retryMs = 300;
  const listen = Commands.createListener();

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

  if (!Recognition) {
    send({ type: 'voice-error', error: 'unsupported' });
    return;
  }

  function start() {
    const rec = new Recognition();
    rec.lang = 'ko-KR';
    rec.continuous = true;
    rec.interimResults = false;
    rec.maxAlternatives = 3;

    rec.onstart = () => {
      retryMs = 300;
      send({ type: 'status', patch: { voice: 'listening' } });
    };

    rec.onspeechstart = () => send({ type: 'speech', active: true });
    rec.onspeechend = () => send({ type: 'speech', active: false });

    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (!event.results[i].isFinal) continue;
        send({ type: 'speech', active: false });
        const alternatives = [...event.results[i]].map((a) => a.transcript);
        const { command, transcript } = listen(alternatives, Date.now());
        if (command) send({ type: 'command', command, transcript });
        else send({ type: 'transcript', transcript });
      }
    };

    rec.onerror = (event) => {
      if (IGNORED.has(event.error)) return;
      send({ type: 'voice-error', error: event.error });
      if (FATAL.has(event.error)) stopped = true;
      else retryMs = Math.min(retryMs * 2, 10000);
    };

    // Chrome ends "continuous" sessions after silence, so keep restarting.
    rec.onend = () => {
      if (!stopped) setTimeout(start, retryMs);
    };

    rec.start();
  }

  start();
})();
