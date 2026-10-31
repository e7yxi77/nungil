// Camera -> MediaPipe -> gaze features. Video frames never leave this document.
import { FaceLandmarker, FilesetResolver } from './vendor/vision_bundle.mjs';

const FRAME_MS = 40;
const video = document.getElementById('video');

const setStatus = (patch) => chrome.runtime.sendMessage({ type: 'status', patch }).catch(() => {});

async function createLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('vendor/wasm'));
  const create = (delegate) => FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: chrome.runtime.getURL('vendor/face_landmarker.task'), delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFacialTransformationMatrixes: true,
    outputFaceBlendshapes: true,
  });
  try {
    return { landmarker: await create('GPU'), delegate: 'GPU' };
  } catch (error) {
    console.warn('GPU delegate unavailable, using CPU', error);
    return { landmarker: await create('CPU'), delegate: 'CPU' };
  }
}

async function startSoundControl() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audio = new AudioContext();
    await audio.resume();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    audio.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const detect = NungilSound.createSoundDetector();
    const COMMANDS = { pop: { name: 'click' }, hum: { name: 'down' } };
    setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      const level = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
      const sound = detect(level, performance.now());
      if (sound) chrome.runtime.sendMessage({ type: 'command', command: COMMANDS[sound], transcript: sound }).catch(() => {});
    }, 50);
    setStatus({ voice: `sound:${audio.state}` });
  } catch (error) {
    setStatus({ voice: `error:${error.name}` });
  }
}

async function main() {
  const params = new URLSearchParams(location.search);
  if (params.get('sound') === '1') startSoundControl();
  if (params.get('camera') === '0') {
    setStatus({ camera: 'off' });
    return;
  }
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' },
    });
    await video.play();
    setStatus({ camera: 'on' });
  } catch (error) {
    setStatus({ camera: `error:${error.name}` });
    return;
  }

  let landmarker;
  try {
    const created = await createLandmarker();
    landmarker = created.landmarker;
    setStatus({ tracker: created.delegate });
  } catch (error) {
    console.error(error);
    setStatus({ tracker: `error:${error.message}` });
    return;
  }

  let lastVideoTime = -1;
  let lastFace = null;
  setInterval(() => {
    if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;
    const result = landmarker.detectForVideo(video, performance.now());
    const landmarks = result.faceLandmarks?.[0];
    const matrix = result.facialTransformationMatrixes?.[0];
    const face = Boolean(landmarks && matrix);
    if (face !== lastFace) {
      lastFace = face;
      setStatus({ face });
    }
    let frame = { type: 'frame', face };
    if (face) {
      const aspect = video.videoHeight / video.videoWidth;
      const { open, ...metrics } = GazeModel.extractFeatures(landmarks, matrix.data, aspect, result.faceBlendshapes?.[0]?.categories);
      frame = { ...frame, ...metrics };
    }
    chrome.runtime.sendMessage(frame).catch(() => {});
  }, FRAME_MS);
}

main();
