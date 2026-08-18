export const RULESET_VERSION = 'vibe-combat-v2-guerrilla/rules-v3.2.6';

const SHA256_K = Object.freeze([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const ROTR = (value, amount) => (value >>> amount) | (value << (32 - amount));

function utf8Bytes(value) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value);
    return Uint8Array.from(unescape(encodeURIComponent(value)), char => char.charCodeAt(0));
}

export function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

export function sha256(value) {
    const bytes = utf8Bytes(typeof value === 'string' ? value : canonical(value));
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(padded.length - 4, bitLength >>> 0);
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const words = new Uint32Array(64);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
        for (let index = 16; index < 64; index += 1) {
            const x = words[index - 15], y = words[index - 2];
            const smallSigma0 = ROTR(x, 7) ^ ROTR(x, 18) ^ (x >>> 3);
            const smallSigma1 = ROTR(y, 17) ^ ROTR(y, 19) ^ (y >>> 10);
            words[index] = (words[index - 16] + smallSigma0 + words[index - 7] + smallSigma1) >>> 0;
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
        for (let index = 0; index < 64; index += 1) {
            const bigSigma1 = ROTR(e, 6) ^ ROTR(e, 11) ^ ROTR(e, 25);
            const choice = (e & f) ^ (~e & g);
            const temp1 = (h + bigSigma1 + choice + SHA256_K[index] + words[index]) >>> 0;
            const bigSigma0 = ROTR(a, 2) ^ ROTR(a, 13) ^ ROTR(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (bigSigma0 + majority) >>> 0;
            h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
        }
        h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map(value => value.toString(16).padStart(8, '0')).join('');
}

export function makeId(prefix = '') {
    const randomUuid = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}${randomUuid}`;
}

export function seed256(value) {
    const source = String(value || `${Date.now()}-${Math.random()}-${Math.random()}`);
    return /^[a-f0-9]{64}$/i.test(source) ? source.toLowerCase() : sha256(source);
}

// xoshiro128**; state and draw index are persisted so reload/replay never rerolls.
export class DeterministicRng {
    constructor(seed, state, index = 0) {
        const hex = seed256(seed);
        this.state = state?.length === 4 ? state.map(Number) : [0, 8, 16, 24].map(offset => {
            const bytes = hex.slice(offset, offset + 8).match(/../g) || [];
            return Number.parseInt(bytes.reverse().join(''), 16) >>> 0;
        });
        if (this.state.every(value => value === 0)) this.state[0] = 1;
        this.index = Number(index) || 0;
    }

    nextUint32() {
        const s = this.state;
        const result = Math.imul(((Math.imul(s[1], 5) << 7) | (Math.imul(s[1], 5) >>> 25)) >>> 0, 9) >>> 0;
        const t = (s[1] << 9) >>> 0;
        s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t;
        s[3] = ((s[3] << 11) | (s[3] >>> 21)) >>> 0;
        this.state = s.map(value => value >>> 0);
        this.index += 1;
        return result;
    }

    int(min, max) {
        return min + (this.nextUint32() % (max - min + 1));
    }

    d100(mode = 'normal') {
        const rolls = [this.int(1, 100)];
        if (mode === 'advantage' || mode === 'disadvantage') rolls.push(this.int(1, 100));
        return { rolls, selected: mode === 'advantage' ? Math.max(...rolls) : mode === 'disadvantage' ? Math.min(...rolls) : rolls[0], mode, rngIndex: this.index };
    }

    snapshot() { return { state: [...this.state], index: this.index }; }
}

export function deepClone(value) { return structuredClone(value); }
