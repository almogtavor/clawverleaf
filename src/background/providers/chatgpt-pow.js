import { sha3_512_hex } from './sha3-512.js';

const PROOF_PREFIX = 'gAAAAAB';
const ARKOSE_URL = 'https://tcr9i.chat.openai.com/v2/35536E1E-65B4-4D96-9D97-6ADB7EFF8147/api.js';
const DPL_PLACEHOLDER = 'dpl=1440a687921de39ff5ee56b92807faaadce73f13';
const MAX_ITERATIONS = 200_000;

const encoder = new TextEncoder();

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function utf8(s) {
  return encoder.encode(s);
}

function pickEnv() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  return {
    ua: nav.userAgent || 'Mozilla/5.0',
    lang: nav.language || 'en-US',
    langs: (nav.languages && nav.languages.join(',')) || 'en-US',
    cores: nav.hardwareConcurrency || 8
  };
}

function buildConfig(deviceId) {
  const env = pickEnv();
  const w = 1920;
  const h = 1080;
  const reactKey = '_reactListening' + Math.random().toString(36).slice(2, 19);
  const events = ['alert', 'ontransitionend', 'onbeforematch', 'onpagereveal'];
  const evt = events[Math.floor(Math.random() * events.length)];
  return [
    env.cores + w + h,
    new Date().toUTCString(),
    4294705152,
    0,
    env.ua,
    ARKOSE_URL,
    DPL_PLACEHOLDER,
    env.lang,
    env.langs,
    0,
    reactKey,
    evt,
    performance.now(),
    deviceId || crypto.randomUUID()
  ];
}

export function solveProofOfWork(seed, difficulty, deviceId) {
  if (!seed || !difficulty) return fallbackToken(deviceId);
  const dlen = difficulty.length;
  const config = buildConfig(deviceId);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    config[3] = i;
    const json = JSON.stringify(config);
    const b64 = bytesToBase64(utf8(json));
    const hash = sha3_512_hex(utf8(seed + b64));
    if (hash.slice(0, dlen) <= difficulty) {
      return PROOF_PREFIX + b64;
    }
  }
  return fallbackToken(deviceId);
}

function fallbackToken(deviceId) {
  const config = buildConfig(deviceId);
  config[3] = Math.floor(Math.random() * 1e6);
  const b64 = bytesToBase64(utf8(JSON.stringify(config)));
  return PROOF_PREFIX + b64;
}
