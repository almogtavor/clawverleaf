const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];

const R = [
  0,  1, 62, 28, 27,
  36, 44,  6, 55, 20,
   3, 10, 43, 25, 39,
  41, 45, 15, 21,  8,
  18,  2, 61, 56, 14
];

const M64 = (1n << 64n) - 1n;

function rotl(v, n) {
  v &= M64;
  const bn = BigInt(n);
  return ((v << bn) | (v >> (64n - bn))) & M64;
}

function keccakF(s) {
  const C = new Array(5);
  const D = new Array(5);
  const B = new Array(25);
  for (let r = 0; r < 24; r++) {
    for (let x = 0; x < 5; x++) {
      C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    }
    for (let i = 0; i < 25; i++) s[i] = (s[i] ^ D[i % 5]) & M64;

    for (let i = 0; i < 25; i++) {
      const x = i % 5;
      const y = (i / 5) | 0;
      const ti = 5 * ((2 * x + 3 * y) % 5) + y;
      B[ti] = R[i] === 0 ? s[i] : rotl(s[i], R[i]);
    }
    for (let y = 0; y < 5; y++) {
      const i = 5 * y;
      const b0 = B[i], b1 = B[i + 1], b2 = B[i + 2], b3 = B[i + 3], b4 = B[i + 4];
      s[i]     = (b0 ^ ((~b1) & M64 & b2)) & M64;
      s[i + 1] = (b1 ^ ((~b2) & M64 & b3)) & M64;
      s[i + 2] = (b2 ^ ((~b3) & M64 & b4)) & M64;
      s[i + 3] = (b3 ^ ((~b4) & M64 & b0)) & M64;
      s[i + 4] = (b4 ^ ((~b0) & M64 & b1)) & M64;
    }
    s[0] = (s[0] ^ RC[r]) & M64;
  }
}

export function sha3_512(input) {
  const rate = 72;
  const state = new Array(25).fill(0n);
  const padded = new Uint8Array(input.length + (rate - (input.length % rate)));
  padded.set(input);
  padded[input.length] = 0x06;
  padded[padded.length - 1] |= 0x80;

  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < 9; i++) {
      let lane = 0n;
      for (let b = 0; b < 8; b++) {
        lane |= BigInt(padded[off + i * 8 + b]) << BigInt(b * 8);
      }
      state[i] ^= lane;
    }
    keccakF(state);
  }

  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    const lane = state[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number((lane >> BigInt(b * 8)) & 0xffn);
    }
  }
  return out;
}

export function sha3_512_hex(input) {
  const out = sha3_512(input);
  let s = '';
  for (let i = 0; i < out.length; i++) s += (out[i] < 16 ? '0' : '') + out[i].toString(16);
  return s;
}
