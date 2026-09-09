/**
 * audio.js — Web Audio engine with fully synthesized sound design.
 *
 * Every sound in Dead Drop is generated procedurally into an AudioBuffer at
 * boot. Nothing is streamed or downloaded. Each sound is built from noise
 * bursts, filtered impulses and pitched oscillator layers shaped by envelopes,
 * which is how real gun-foley layers work (transient + body + tail).
 *
 * Spatialisation: every world sound goes through a PannerNode using HRTF,
 * inverse distance rolloff, refDistance 1, rolloffFactor 2 — so a chest hum
 * is directional and audible from ~24m, and a distant SCAR is a thin crack.
 */

const SR = 48000;

/* ------------------------------------------------------------------ */
/* DSP primitives                                                      */
/* ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exponential decay envelope. */
function envExp(t, dur, curve = 6) {
  const x = t / dur;
  return x >= 1 ? 0 : Math.exp(-curve * x);
}

/** Attack-decay envelope with a short click-free attack. */
function envAD(t, dur, attack = 0.002, curve = 5) {
  if (t < attack) return t / attack;
  return envExp(t - attack, dur - attack, curve);
}

/** One-pole lowpass state helper. */
function makeLP() {
  let y = 0;
  return (x, a) => (y = y + a * (x - y));
}

/** One-pole highpass. */
function makeHP() {
  let prevX = 0;
  let y = 0;
  return (x, a) => {
    y = a * (y + x - prevX);
    prevX = x;
    return y;
  };
}

/** Simple resonant bandpass (state variable filter). */
function makeSVF() {
  let low = 0;
  let band = 0;
  return (x, f, q) => {
    low += f * band;
    const high = x - low - q * band;
    band += f * high;
    return { low, band, high };
  };
}

/* ------------------------------------------------------------------ */
/* Sound synthesis recipes                                             */
/* ------------------------------------------------------------------ */

/**
 * Gunshot generator. Layers:
 *  - transient: very short filtered noise burst (the "crack")
 *  - body: resonant low thump (the "boom")
 *  - tail: decaying noise through a lowpass (the room/air)
 *  - mech: optional metallic click (action cycling)
 */
function synthGunshot(opts) {
  const {
    duration = 0.42, seed = 1, bodyFreq = 120, bodyDecay = 22,
    crackAmount = 1.0, crackBright = 0.55, tailAmount = 0.5, tailDecay = 7,
    mech = 0.0, punch = 1.0, suppressed = false,
  } = opts;

  const n = Math.floor(SR * duration);
  const buf = new Float32Array(n);
  const rnd = mulberry32(seed);
  const lp = makeLP();
  const hp = makeHP();
  const lpTail = makeLP();

  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const white = rnd() * 2 - 1;

    // Transient crack — bright noise, extremely fast decay.
    const crackEnv = envExp(t, suppressed ? 0.02 : 0.045, suppressed ? 20 : 30);
    let crack = hp(white, crackBright) * crackEnv * crackAmount;

    // Body — pitched sine sweeping down, gives the shot weight.
    const sweep = bodyFreq * (1 + 2.2 * Math.exp(-t * 60));
    const bodyEnv = envExp(t, duration * 0.5, bodyDecay);
    const body = Math.sin(2 * Math.PI * sweep * t) * bodyEnv * punch;

    // Tail — filtered noise, the air/room decay.
    const tailEnv = envExp(t, duration, tailDecay);
    const tail = lpTail(white, 0.12) * tailEnv * tailAmount;

    // Mechanical action click a few ms in.
    let m = 0;
    if (mech > 0) {
      const mt = t - 0.012;
      if (mt > 0) m = (rnd() * 2 - 1) * envExp(mt, 0.03, 40) * mech;
    }

    let s = crack * 0.9 + body * 0.75 + tail * 0.6 + m * 0.4;
    s = lp(s, 0.85); // gentle top-end tame
    buf[i] = Math.tanh(s * 1.6) * 0.85; // soft clip for loudness/character
  }
  return buf;
}

/** Explosion: deep sub, wide noise blast, long rumble tail. */
function synthExplosion(opts) {
  const { duration = 1.8, seed = 2, size = 1.0 } = opts;
  const n = Math.floor(SR * duration);
  const buf = new Float32Array(n);
  const rnd = mulberry32(seed);
  const lp1 = makeLP();
  const lp2 = makeLP();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const white = rnd() * 2 - 1;
    // Sub-bass drop.
    const subF = 58 / size * (1 + 1.5 * Math.exp(-t * 12));
    const sub = Math.sin(2 * Math.PI * subF * t) * envExp(t, duration * 0.6, 5);
    // Initial blast.
    const blast = lp1(white, 0.5) * envExp(t, 0.25, 14);
    // Long rumble.
    const rumble = lp2(white, 0.035) * envExp(t, duration, 3.2);
    const s = sub * 1.1 + blast * 0.85 + rumble * 0.7;
    buf[i] = Math.tanh(s * 1.4) * 0.9;
  }
  return buf;
}

/** Impact/thud used for building placement and footsteps. */
function synthImpact(opts) {
  const {
    duration = 0.3, seed = 3, freq = 90, decay = 18,
    noiseAmount = 0.6, noiseColor = 0.2, ring = 0, ringFreq = 900, ringDecay = 14,
  } = opts;
  const n = Math.floor(SR * duration);
  const buf = new Float32Array(n);
  const rnd = mulberry32(seed);
  const lp = makeLP();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const white = rnd() * 2 - 1;
    const thump = Math.sin(2 * Math.PI * freq * (1 + 0.8 * Math.exp(-t * 40)) * t) * envExp(t, duration, decay);
    const noise = lp(white, noiseColor) * envExp(t, duration * 0.5, decay * 1.3) * noiseAmount;
    let r = 0;
    if (ring > 0) {
      r = Math.sin(2 * Math.PI * ringFreq * t) * envExp(t, duration, ringDecay) * ring;
      r += Math.sin(2 * Math.PI * ringFreq * 1.51 * t) * envExp(t, duration, ringDecay * 1.2) * ring * 0.5;
    }
    buf[i] = Math.tanh((thump + noise + r) * 1.2) * 0.8;
  }
  return buf;
}

/** Wood creak — pitched friction, used for wood builds and harvesting. */
function synthCreak(opts) {
  const { duration = 0.35, seed = 4, baseFreq = 220 } = opts;
  const n = Math.floor(SR * duration);
  const buf = new Float32Array(n);
  const rnd = mulberry32(seed);
  const svf = makeSVF();
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // Stick-slip friction modulation.
    const jitter = 1 + 0.35 * Math.sin(2 * Math.PI * 23 * t) + 0.15 * (rnd() - 0.5);
    phase += ((baseFreq * jitter) / SR) * 2 * Math.PI;
    const tone = Math.sin(phase) * 0.5 + Math.sin(phase * 2.02) * 0.2;
    const white = rnd() * 2 - 1;
    const f = svf(white, 0.06, 0.4);
    const env = envAD(t, duration, 0.008, 7);
    buf[i] = Math.tanh((tone * 0.7 + f.band * 0.5) * env * 1.3) * 0.62;
  }
  return buf;
}

/** Metallic clang with inharmonic partials. */
function synthClang(opts) {
  const { duration = 0.75, seed = 5, base = 520, partials = [1, 1.72, 2.41, 3.11, 4.77], bright = 1 } = opts;
  const n = Math.floor(SR * duration);
  const buf = new Float32Array(n);
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    for (let p = 0; p < partials.length; p++) {
      const f = base * partials[p];
      const amp = 1 / (p + 1.4);
      s += Math.sin(2 * Math.PI * f * t) * amp * envExp(t, duration, 4 + p * 2.2);
    }
    const strike = (rnd() * 2 - 1) * envExp(t, 0.02, 45) * bright;
    buf[i] = Math.tanh((s * 0.5 + strike * 0.6) * 1.2) * 0.7;
  }
  return buf;
}

/** Stone chip for brick/rock harvesting. */
function synthStone(opts) {
  const { duration = 0.28, seed = 6 } = opts;
  const n = Math.floor(SR * duration);
  const buf = new Float32Array(n);
  const rnd = mulberry32(seed);
  const hp = makeHP();
  const lp = makeLP();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const white = rnd() * 2 - 1;
    const crack = hp(white, 0.6) * envExp(t, 0.05, 30);
    const body = lp(white, 0.25) * envExp(t, duration, 16);
    const thud = Math.sin(2 * Math.PI * 150 * t) * envExp(t, 0.1, 24);
    buf[i] = Math.tanh((crack * 0.8 + body * 0.6 + thud * 0.5) * 1.3) * 0.72;
  }
  return buf;
}

/** Footstep — surface-dependent. */
function synthFootstep(surface, seed) {
  switch (surface) {
    case 'concrete':
      return synthImpact({ duration: 0.16, seed, freq: 150, decay: 34, noiseAmount: 0.5, noiseColor: 0.45, ring: 0.08, ringFreq: 1800 });
    case 'wood':
      return synthImpact({ duration: 0.2, seed, freq: 120, decay: 26, noiseAmount: 0.45, noiseColor: 0.3, ring: 0.16, ringFreq: 420, ringDecay: 22 });
    case 'metal':
      return synthClang({ duration: 0.26, seed, base: 780, partials: [1, 1.9, 2.7], bright: 0.5 });
    case 'gravel':
      return synthImpact({ duration: 0.19, seed, freq: 110, decay: 30, noiseAmount: 0.95, noiseColor: 0.55 });
    case 'sand':
      return synthImpact({ duration: 0.17, seed, freq: 85, decay: 30, noiseAmount: 0.85, noiseColor: 0.14 });
    case 'water':
      return synthImpact({ duration: 0.32, seed, freq: 70, decay: 16, noiseAmount: 1.0, noiseColor: 0.09 });
    case 'grass':
    default:
      return synthImpact({ duration: 0.16, seed, freq: 95, decay: 32, noiseAmount: 0.7, noiseColor: 0.18 });
  }
}

/** Looping wind/noise bed. Loops seamlessly via crossfaded wrap. */
function synthWindLoop(opts) {
  const { duration = 4.0, seed = 9, color = 0.02, mod = 0.35, sub = 0 } = opts;
  const n = Math.floor(SR * duration);
  const raw = new Float32Array(n);
  const rnd = mulberry32(seed);
  const lp = makeLP();
  const lp2 = makeLP();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const white = rnd() * 2 - 1;
    let s = lp(white, color);
    s = lp2(s, 0.35);
    // Slow gusting.
    const gust = 1 + mod * (Math.sin(2 * Math.PI * 0.11 * t) * 0.6 + Math.sin(2 * Math.PI * 0.23 * t + 1.1) * 0.4);
    s *= gust;
    if (sub > 0) s += Math.sin(2 * Math.PI * 42 * t) * sub * (0.8 + 0.2 * Math.sin(2 * Math.PI * 0.17 * t));
    raw[i] = s;
  }

  // Normalise: the one-pole cascade output level varies wildly with `color`,
  // so scale to a fixed peak rather than applying a blind fixed gain.
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(raw[i]);
    if (a > peak) peak = a;
  }
  if (peak > 1e-6) {
    const g = 0.72 / peak;
    for (let i = 0; i < n; i++) raw[i] *= g;
  }
  // Crossfade the tail into the head for a seamless loop. The fade must
  // never exceed a third of the buffer — short one-shot "wind" sounds
  // (pickaxe swing, jump whoosh) are only a couple hundred milliseconds.
  const fade = Math.max(1, Math.min(Math.floor(SR * 0.5), Math.floor(n / 3)));
  const out = new Float32Array(n - fade);
  out.set(raw.subarray(0, n - fade));
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    out[i] = out[i] * k + raw[n - fade + i] * (1 - k);
  }
  return out;
}

/** Chest hum — warm pulsing tonal loop with a magical shimmer. */
function synthChestHum(duration = 2.0) {
  const n = Math.floor(SR * duration);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // Perfect-fifth drone with slow tremolo.
    const trem = 0.75 + 0.25 * Math.sin(2 * Math.PI * 1.6 * t);
    let s =
      Math.sin(2 * Math.PI * 146.8 * t) * 0.35 +
      Math.sin(2 * Math.PI * 220.0 * t) * 0.28 +
      Math.sin(2 * Math.PI * 293.7 * t) * 0.18 +
      Math.sin(2 * Math.PI * 587.3 * t) * 0.06 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.7 * t));
    raw[i] = s * trem * 0.5;
  }
  // Loop is already periodic at these harmonic ratios; light crossfade anyway.
  const fade = Math.max(1, Math.min(Math.floor(SR * 0.2), Math.floor(n / 3)));
  const out = new Float32Array(n - fade);
  out.set(raw.subarray(0, n - fade));
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    out[i] = out[i] * k + raw[n - fade + i] * (1 - k);
  }
  return out;
}

/** UI chime — bell-like, pitch varies by rarity. */
function synthChime(opts) {
  const { duration = 0.9, base = 880, seed = 12, shimmer = 1 } = opts;
  const n = Math.floor(SR * duration);
  const buf = new Float32Array(n);
  const partials = [1, 2, 3.01, 4.2, 5.4];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    for (let p = 0; p < partials.length; p++) {
      s += Math.sin(2 * Math.PI * base * partials[p] * t) * (1 / (p + 1.5)) * envExp(t, duration, 3 + p * 1.6);
    }
    if (shimmer > 0) {
      s += Math.sin(2 * Math.PI * base * 8 * t) * 0.05 * envExp(t, 0.15, 18) * shimmer;
    }
    buf[i] = Math.tanh(s * 0.8) * 0.55;
  }
  return buf;
}

/** Short UI click. */
function synthClick(opts) {
  const { duration = 0.06, seed = 13, freq = 1400 } = opts;
  const n = Math.floor(SR * duration);
  const buf = new Float32Array(n);
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const tick = (rnd() * 2 - 1) * envExp(t, 0.012, 55);
    const tone = Math.sin(2 * Math.PI * freq * t) * envExp(t, duration, 40);
    buf[i] = (tick * 0.5 + tone * 0.5) * 0.5;
  }
  return buf;
}

/** Victory fanfare — major triad arpeggio with brassy saw layers. */
function synthFanfare() {
  const duration = 3.4;
  const n = Math.floor(SR * duration);
  const buf = new Float32Array(n);
  // C-E-G-C major arpeggio then a held chord.
  const notes = [
    { f: 523.25, t: 0.0, d: 0.42 },
    { f: 659.25, t: 0.18, d: 0.42 },
    { f: 783.99, t: 0.36, d: 0.5 },
    { f: 1046.5, t: 0.56, d: 2.6 },
    { f: 523.25, t: 0.56, d: 2.6 },
    { f: 659.25, t: 0.56, d: 2.6 },
    { f: 783.99, t: 0.56, d: 2.6 },
  ];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    for (const nt of notes) {
      const lt = t - nt.t;
      if (lt < 0 || lt > nt.d) continue;
      const env = envAD(lt, nt.d, 0.02, 3.2);
      // Saw-ish brass via summed harmonics.
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * nt.f * h * lt) / h;
      // Slight vibrato on the sustained chord.
      const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * lt);
      s += v * env * 0.16 * vib;
    }
    buf[i] = Math.tanh(s * 1.1) * 0.6;
  }
  return buf;
}

/** Bus horn — two-tone airhorn. */
function synthBusHorn() {
  const duration = 1.6;
  const n = Math.floor(SR * duration);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = t < 0.05 ? t / 0.05 : t > 1.2 ? Math.max(0, 1 - (t - 1.2) / 0.4) : 1;
    let s = 0;
    for (const f of [233.1, 293.7]) {
      for (let h = 1; h <= 8; h++) {
        s += Math.sin(2 * Math.PI * f * h * t) * (1 / (h * 1.3)) * 0.5;
      }
    }
    buf[i] = Math.tanh(s * 0.35 * env) * 0.6;
  }
  return buf;
}

/** Engine hum loop for the battle bus. */
function synthEngineLoop() {
  const duration = 2.0;
  const n = Math.floor(SR * duration);
  const raw = new Float32Array(n);
  const rnd = mulberry32(31);
  const lp = makeLP();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    // Firing order harmonics.
    for (const [f, a] of [[42, 0.5], [84, 0.3], [126, 0.18], [168, 0.1]]) {
      s += Math.sin(2 * Math.PI * f * t) * a;
    }
    s += lp(rnd() * 2 - 1, 0.08) * 0.35;
    s *= 0.9 + 0.1 * Math.sin(2 * Math.PI * 3.1 * t);
    raw[i] = s * 0.5;
  }
  const fade = Math.max(1, Math.min(Math.floor(SR * 0.25), Math.floor(n / 3)));
  const out = new Float32Array(n - fade);
  out.set(raw.subarray(0, n - fade));
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    out[i] = out[i] * k + raw[n - fade + i] * (1 - k);
  }
  return out;
}

/** Glider deploy — fabric snap plus wind shift. */
function synthGliderDeploy() {
  const duration = 0.9;
  const n = Math.floor(SR * duration);
  const buf = new Float32Array(n);
  const rnd = mulberry32(41);
  const lp = makeLP();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const white = rnd() * 2 - 1;
    // Fabric snap: burst of filtered noise with a fast flutter.
    const flutter = 1 + 0.5 * Math.sin(2 * Math.PI * 28 * t);
    const snap = lp(white, 0.5) * envExp(t, 0.22, 12) * flutter;
    // Wind settling in behind it.
    const wind = lp(white, 0.05) * Math.min(1, t / 0.3) * envExp(Math.max(0, t - 0.3), 0.6, 2) * 0.6;
    buf[i] = Math.tanh((snap * 0.8 + wind) * 1.2) * 0.6;
  }
  return buf;
}

/** Storm damage tick — soft energy pulse. */
function synthEnergyPulse() {
  const duration = 0.45;
  const n = Math.floor(SR * duration);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 320 * (1 - 0.4 * t / duration);
    const s = Math.sin(2 * Math.PI * f * t) * envAD(t, duration, 0.01, 6);
    const shimmer = Math.sin(2 * Math.PI * f * 3.02 * t) * envExp(t, 0.2, 10) * 0.3;
    buf[i] = (s * 0.5 + shimmer) * 0.45;
  }
  return buf;
}

/** Electrical crackle for the storm wall. */
function synthCrackleLoop() {
  const duration = 3.0;
  const n = Math.floor(SR * duration);
  const raw = new Float32Array(n);
  const rnd = mulberry32(53);
  const hp = makeHP();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // Sparse random arcs.
    let s = 0;
    if (rnd() < 0.0016) s = (rnd() * 2 - 1) * 2.2;
    s = hp(s, 0.75);
    raw[i] = s * 0.5 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.37 * t));
  }
  // Smear each arc into a short decay.
  let tailv = 0;
  for (let i = 0; i < n; i++) {
    tailv = Math.max(Math.abs(raw[i]), tailv * 0.9993);
    raw[i] = raw[i] * 0.6 + Math.sign(raw[i] || 1) * tailv * 0.12 * (mulberry32(i)() - 0.5);
  }
  const fade = Math.max(1, Math.min(Math.floor(SR * 0.3), Math.floor(n / 3)));
  const out = new Float32Array(n - fade);
  out.set(raw.subarray(0, n - fade));
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    out[i] = out[i] * k + raw[n - fade + i] * (1 - k);
  }
  return out;
}

/** Hit marker tick. */
function synthHitMarker(headshot = false) {
  const duration = 0.12;
  const n = Math.floor(SR * duration);
  const buf = new Float32Array(n);
  const f = headshot ? 1650 : 1150;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const s = Math.sin(2 * Math.PI * f * t) * envExp(t, duration, 26);
    const s2 = Math.sin(2 * Math.PI * f * 1.5 * t) * envExp(t, duration * 0.6, 32) * 0.5;
    buf[i] = (s + s2) * 0.32;
  }
  return buf;
}

/** Reverb impulse response for the ConvolverNode. */
function synthImpulse(duration, decay, seed, damping = 0.25) {
  const n = Math.floor(SR * duration);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const rndL = mulberry32(seed);
  const rndR = mulberry32(seed + 977);
  const lpL = makeLP();
  const lpR = makeLP();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.pow(1 - i / n, decay);
    left[i] = lpL(rndL() * 2 - 1, damping) * env;
    right[i] = lpR(rndR() * 2 - 1, damping) * env;
  }
  return [left, right];
}

/* ------------------------------------------------------------------ */
/* Sound bank definition                                               */
/* ------------------------------------------------------------------ */

const BANK = {
  // --- Weapons ----------------------------------------------------
  'weapon.scar':          () => synthGunshot({ seed: 101, duration: 0.4,  bodyFreq: 132, crackBright: 0.55, tailAmount: 0.5, mech: 0.3, punch: 1.0 }),
  'weapon.m16':           () => synthGunshot({ seed: 103, duration: 0.3,  bodyFreq: 150, crackBright: 0.66, tailAmount: 0.38, mech: 0.35, punch: 0.85 }),
  'weapon.suppressed_ar': () => synthGunshot({ seed: 105, duration: 0.2,  bodyFreq: 96,  crackBright: 0.25, crackAmount: 0.4, tailAmount: 0.18, mech: 0.55, punch: 0.5, suppressed: true }),
  'weapon.pump':          () => synthGunshot({ seed: 107, duration: 0.75, bodyFreq: 74,  crackBright: 0.42, tailAmount: 0.85, tailDecay: 4.5, punch: 1.5 }),
  'weapon.pump_rack':     () => synthClang({ duration: 0.3, seed: 108, base: 340, partials: [1, 2.3, 3.6], bright: 0.8 }),
  'weapon.tactical_shotgun': () => synthGunshot({ seed: 109, duration: 0.6, bodyFreq: 88, crackBright: 0.48, tailAmount: 0.7, tailDecay: 5.5, punch: 1.2 }),
  'weapon.tactical_smg':  () => synthGunshot({ seed: 111, duration: 0.2,  bodyFreq: 178, crackBright: 0.7,  tailAmount: 0.3, mech: 0.45, punch: 0.62 }),
  'weapon.minigun':       () => synthGunshot({ seed: 113, duration: 0.17, bodyFreq: 190, crackBright: 0.72, tailAmount: 0.26, mech: 0.5, punch: 0.55 }),
  'weapon.minigun_spin':  () => synthWindLoop({ duration: 1.5, seed: 114, color: 0.2, mod: 0.1, sub: 0.25 }),
  'weapon.bolt_sniper':   () => synthGunshot({ seed: 115, duration: 1.5,  bodyFreq: 108, crackBright: 0.78, tailAmount: 0.95, tailDecay: 2.2, punch: 1.35 }),
  'weapon.semi_sniper':   () => synthGunshot({ seed: 117, duration: 1.0,  bodyFreq: 118, crackBright: 0.72, tailAmount: 0.75, tailDecay: 3.0, punch: 1.1 }),
  'weapon.hand_cannon':   () => synthGunshot({ seed: 119, duration: 0.62, bodyFreq: 112, crackBright: 0.62, tailAmount: 0.62, tailDecay: 4.5, punch: 1.25 }),
  'weapon.pistol':        () => synthGunshot({ seed: 121, duration: 0.28, bodyFreq: 168, crackBright: 0.62, tailAmount: 0.34, mech: 0.4, punch: 0.7 }),
  'weapon.grenade_launcher': () => synthImpact({ duration: 0.4, seed: 123, freq: 130, decay: 12, noiseAmount: 0.5, noiseColor: 0.2, ring: 0.2, ringFreq: 300 }),
  'weapon.rpg':           () => synthWindLoop({ duration: 0.9, seed: 125, color: 0.25, mod: 0.2, sub: 0.3 }),
  'weapon.dryfire':       () => synthClick({ duration: 0.09, seed: 127, freq: 900 }),
  'weapon.reload_start':  () => synthClang({ duration: 0.22, seed: 129, base: 420, partials: [1, 2.1, 3.4], bright: 0.5 }),
  'weapon.reload_end':    () => synthClang({ duration: 0.3, seed: 131, base: 300, partials: [1, 1.8, 2.9], bright: 0.9 }),
  'weapon.switch':        () => synthClick({ duration: 0.14, seed: 133, freq: 620 }),
  'weapon.bolt_cycle':    () => synthClang({ duration: 0.4, seed: 135, base: 520, partials: [1, 1.6, 2.8, 4.1], bright: 0.7 }),

  // --- Explosions -------------------------------------------------
  'explosion.grenade':    () => synthExplosion({ duration: 1.7, seed: 141, size: 1.0 }),
  'explosion.rocket':     () => synthExplosion({ duration: 2.2, seed: 143, size: 0.82 }),
  'explosion.clinger':    () => synthExplosion({ duration: 1.4, seed: 145, size: 1.15 }),
  'grenade.bounce':       () => synthImpact({ duration: 0.16, seed: 147, freq: 220, decay: 30, noiseAmount: 0.3, noiseColor: 0.35, ring: 0.15, ringFreq: 700 }),
  'grenade.pin':          () => synthClick({ duration: 0.1, seed: 149, freq: 1800 }),

  // --- Building ---------------------------------------------------
  'build.wood':           () => synthCreak({ duration: 0.4, seed: 151, baseFreq: 190 }),
  'build.brick':          () => synthImpact({ duration: 0.42, seed: 153, freq: 76, decay: 16, noiseAmount: 0.75, noiseColor: 0.22 }),
  'build.metal':          () => synthClang({ duration: 0.7, seed: 155, base: 460, partials: [1, 1.74, 2.42, 3.6, 5.1], bright: 1.0 }),
  'build.break_wood':     () => synthCreak({ duration: 0.6, seed: 157, baseFreq: 120 }),
  'build.break_brick':    () => synthStone({ duration: 0.55, seed: 159 }),
  'build.break_metal':    () => synthClang({ duration: 0.9, seed: 161, base: 380, partials: [1, 1.9, 2.6, 3.9, 5.7], bright: 1.2 }),
  'build.edit':           () => synthClick({ duration: 0.08, seed: 163, freq: 2000 }),
  'build.rotate':         () => synthClick({ duration: 0.06, seed: 165, freq: 1200 }),
  'build.invalid':        () => synthClick({ duration: 0.1, seed: 167, freq: 260 }),

  // --- Harvesting -------------------------------------------------
  'harvest.wood':         () => synthCreak({ duration: 0.3, seed: 171, baseFreq: 260 }),
  'harvest.stone':        () => synthStone({ duration: 0.3, seed: 173 }),
  'harvest.metal':        () => synthClang({ duration: 0.45, seed: 175, base: 700, partials: [1, 1.8, 2.9, 4.3], bright: 1.1 }),
  'harvest.weakpoint':    () => synthChime({ duration: 0.5, base: 1320, seed: 177, shimmer: 1 }),
  'pickaxe.swing':        () => synthWindLoop({ duration: 0.3, seed: 179, color: 0.3, mod: 0 }),

  // --- Chest / loot -----------------------------------------------
  'chest.hum':            () => synthChestHum(2.0),
  'chest.open':           () => synthCreak({ duration: 0.7, seed: 181, baseFreq: 140 }),
  'loot.spawn':           () => synthChime({ duration: 0.6, base: 1046, seed: 183, shimmer: 1 }),
  'loot.pickup_common':   () => synthChime({ duration: 0.4, base: 700, seed: 185, shimmer: 0.3 }),
  'loot.pickup_uncommon': () => synthChime({ duration: 0.45, base: 784, seed: 186, shimmer: 0.5 }),
  'loot.pickup_rare':     () => synthChime({ duration: 0.5, base: 880, seed: 187, shimmer: 0.7 }),
  'loot.pickup_epic':     () => synthChime({ duration: 0.55, base: 988, seed: 188, shimmer: 0.9 }),
  'loot.pickup_legendary':() => synthChime({ duration: 0.75, base: 1174, seed: 189, shimmer: 1.4 }),
  'loot.ammo':            () => synthClick({ duration: 0.12, seed: 191, freq: 800 }),

  // --- Footsteps --------------------------------------------------
  'step.grass':           () => synthFootstep('grass', 201),
  'step.grass2':          () => synthFootstep('grass', 202),
  'step.concrete':        () => synthFootstep('concrete', 203),
  'step.concrete2':       () => synthFootstep('concrete', 204),
  'step.wood':            () => synthFootstep('wood', 205),
  'step.wood2':           () => synthFootstep('wood', 206),
  'step.metal':           () => synthFootstep('metal', 207),
  'step.gravel':          () => synthFootstep('gravel', 208),
  'step.sand':            () => synthFootstep('sand', 209),
  'step.water':           () => synthFootstep('water', 210),
  'player.land':          () => synthImpact({ duration: 0.35, seed: 211, freq: 68, decay: 14, noiseAmount: 0.6, noiseColor: 0.2 }),
  'player.jump':          () => synthWindLoop({ duration: 0.22, seed: 213, color: 0.35, mod: 0 }),

  // --- Storm ------------------------------------------------------
  'storm.rumble':         () => synthWindLoop({ duration: 5.0, seed: 221, color: 0.012, mod: 0.5, sub: 0.28 }),
  'storm.wall':           () => synthWindLoop({ duration: 4.0, seed: 223, color: 0.05, mod: 0.6, sub: 0.12 }),
  'storm.crackle':        () => synthCrackleLoop(),
  'storm.inside':         () => synthWindLoop({ duration: 4.0, seed: 225, color: 0.09, mod: 0.45, sub: 0.05 }),
  'storm.tick':           () => synthEnergyPulse(),
  'storm.warning':        () => synthChime({ duration: 1.2, base: 392, seed: 227, shimmer: 0 }),

  // --- Bus / skydive ----------------------------------------------
  'bus.horn':             () => synthBusHorn(),
  'bus.engine':           () => synthEngineLoop(),
  'skydive.wind':         () => synthWindLoop({ duration: 4.0, seed: 231, color: 0.14, mod: 0.25 }),
  'glider.deploy':        () => synthGliderDeploy(),
  'glider.flight':        () => synthWindLoop({ duration: 4.0, seed: 233, color: 0.045, mod: 0.35 }),

  // --- Ambience ---------------------------------------------------
  'ambient.wind':         () => synthWindLoop({ duration: 6.0, seed: 241, color: 0.02, mod: 0.4 }),
  'ambient.forest':       () => synthWindLoop({ duration: 6.0, seed: 243, color: 0.035, mod: 0.5 }),
  'ambient.water':        () => synthWindLoop({ duration: 5.0, seed: 245, color: 0.07, mod: 0.3 }),

  // --- UI / feedback ----------------------------------------------
  'ui.hit':               () => synthHitMarker(false),
  'ui.hit_headshot':      () => synthHitMarker(true),
  'ui.hit_shield':        () => synthChime({ duration: 0.18, base: 1320, seed: 251, shimmer: 0.4 }),
  'ui.eliminate':         () => synthChime({ duration: 0.8, base: 660, seed: 253, shimmer: 1.2 }),
  'ui.click':             () => synthClick({ duration: 0.05, seed: 255, freq: 1500 }),
  'ui.slot':              () => synthClick({ duration: 0.045, seed: 257, freq: 1100 }),
  'ui.victory':           () => synthFanfare(),
  'ui.defeat':            () => synthChime({ duration: 1.6, base: 330, seed: 259, shimmer: 0 }),
  'ui.heal':              () => synthChime({ duration: 0.5, base: 587, seed: 261, shimmer: 0.6 }),
  'ui.shield':            () => synthChime({ duration: 0.55, base: 740, seed: 263, shimmer: 0.8 }),
  'ui.damage':            () => synthImpact({ duration: 0.2, seed: 265, freq: 180, decay: 26, noiseAmount: 0.5, noiseColor: 0.4 }),
};

/** Sounds that are looped when played. */
const LOOPING = new Set([
  'chest.hum', 'storm.rumble', 'storm.wall', 'storm.crackle', 'storm.inside',
  'bus.engine', 'skydive.wind', 'glider.flight', 'ambient.wind',
  'ambient.forest', 'ambient.water', 'weapon.minigun_spin',
]);

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.ready = false;
    this.muted = false;

    this.volumes = { master: 0.8, sfx: 1.0, ui: 0.9, music: 0.6, ambient: 0.55 };
    this._loops = new Map();
    this._activeVoices = 0;
    this.maxVoices = 48;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  async init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ sampleRate: SR, latencyHint: 'interactive' });

    // --- Bus graph -------------------------------------------------
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volumes.master;

    // Master limiter so simultaneous explosions never clip harshly.
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = this.volumes.sfx;
    this.uiBus = this.ctx.createGain();
    this.uiBus.gain.value = this.volumes.ui;
    this.ambientBus = this.ctx.createGain();
    this.ambientBus.gain.value = this.volumes.ambient;

    // Reverb send — gives outdoor shots their tail and interiors their space.
    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = this._makeImpulseBuffer(2.2, 3.2, 991, 0.22);
    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 0.16;
    this.reverbReturn = this.ctx.createGain();
    this.reverbReturn.gain.value = 0.85;

    this.sfxBus.connect(this.master);
    this.uiBus.connect(this.master);
    this.ambientBus.connect(this.master);
    this.sfxBus.connect(this.reverbSend);
    this.reverbSend.connect(this.convolver);
    this.convolver.connect(this.reverbReturn);
    this.reverbReturn.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(this.ctx.destination);

    this.listener = this.ctx.listener;

    await this._buildBank();
    this.ready = true;
  }

  _makeImpulseBuffer(duration, decay, seed, damping) {
    const [l, r] = synthImpulse(duration, decay, seed, damping);
    const buf = this.ctx.createBuffer(2, l.length, SR);
    buf.copyToChannel(l, 0);
    buf.copyToChannel(r, 1);
    return buf;
  }

  /** Synthesize every sound into AudioBuffers, yielding to keep the UI alive. */
  async _buildBank() {
    const entries = Object.entries(BANK);
    let i = 0;
    for (const [id, gen] of entries) {
      const data = gen();
      const buf = this.ctx.createBuffer(1, data.length, SR);
      buf.copyToChannel(data, 0);
      this.buffers.set(id, buf);
      i++;
      // Yield every few sounds so the loading screen can repaint.
      if (i % 6 === 0) {
        this.onProgress?.(i / entries.length);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    this.onProgress?.(1);
  }

  /* ---------------------------------------------------------------- */

  /** Update the HRTF listener from the camera each frame. */
  setListener(position, forward, up) {
    if (!this.ready) return;
    const l = this.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(position.x, t, 0.01);
      l.positionY.setTargetAtTime(position.y, t, 0.01);
      l.positionZ.setTargetAtTime(position.z, t, 0.01);
      l.forwardX.setTargetAtTime(forward.x, t, 0.01);
      l.forwardY.setTargetAtTime(forward.y, t, 0.01);
      l.forwardZ.setTargetAtTime(forward.z, t, 0.01);
      l.upX.setTargetAtTime(up.x, t, 0.01);
      l.upY.setTargetAtTime(up.y, t, 0.01);
      l.upZ.setTargetAtTime(up.z, t, 0.01);
    } else {
      l.setPosition(position.x, position.y, position.z);
      l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  _makePanner(pos, refDistance = 1, rolloffFactor = 2, maxDistance = 900) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = refDistance;
    p.rolloffFactor = rolloffFactor;
    p.maxDistance = maxDistance;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    return p;
  }

  /**
   * Play a one-shot.
   * @param {string} id
   * @param {object} opts { position, volume, rate, bus, refDistance, rolloff, detune, filter }
   */
  play(id, opts = {}) {
    if (!this.ready || this.muted) return null;
    const buf = this.buffers.get(id);
    if (!buf) return null;
    if (this._activeVoices > this.maxVoices) return null;

    const {
      position = null, volume = 1, rate = 1, bus = 'sfx',
      refDistance = 1, rolloff = 2, maxDistance = 900,
      lowpass = 0, delay = 0,
    } = opts;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;

    const gain = this.ctx.createGain();
    gain.gain.value = volume;

    let node = src;
    // Distance-based muffling: far gunshots lose their high end.
    if (lowpass > 0 && lowpass < 20000) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      node.connect(f);
      node = f;
    }
    node.connect(gain);

    const destBus = bus === 'ui' ? this.uiBus : bus === 'ambient' ? this.ambientBus : this.sfxBus;

    if (position) {
      const panner = this._makePanner(position, refDistance, rolloff, maxDistance);
      gain.connect(panner);
      panner.connect(destBus);
    } else {
      gain.connect(destBus);
    }

    this._activeVoices++;
    src.onended = () => { this._activeVoices--; };
    src.start(this.ctx.currentTime + delay);
    return src;
  }

  /**
   * Play a gunshot with automatic distance treatment: far shots are quieter,
   * muffled and arrive late (speed of sound), which is what lets a player
   * locate a fight across the valley.
   */
  playShot(weaponId, position, listenerPos, opts = {}) {
    if (!this.ready) return;
    const dx = position.x - listenerPos.x;
    const dy = position.y - listenerPos.y;
    const dz = position.z - listenerPos.z;
    const dist = Math.hypot(dx, dy, dz);

    const id = `weapon.${weaponId}`;
    if (!this.buffers.has(id)) return;

    // Air absorption: high frequencies vanish with distance.
    const lowpass = Math.max(320, 20000 * Math.exp(-dist / 140));
    // Sound travel delay at ~343 m/s.
    const delay = Math.min(1.2, dist / 343);

    this.play(id, {
      position,
      volume: (opts.volume ?? 1) * 1.0,
      rate: opts.rate ?? (0.97 + Math.random() * 0.06),
      refDistance: 8,
      rolloff: 1.15,
      maxDistance: 1400,
      lowpass,
      delay,
    });
  }

  /**
   * Start (or retrieve) a looping spatial sound, e.g. a chest hum.
   * Returns a handle with { setPosition, setVolume, stop }.
   */
  loop(id, opts = {}) {
    if (!this.ready) return null;
    const buf = this.buffers.get(id);
    if (!buf) return null;

    const {
      key = id, position = null, volume = 1, rate = 1, bus = 'sfx',
      refDistance = 3, rolloff = 2.2, maxDistance = 200, fadeIn = 0.25,
    } = opts;

    if (this._loops.has(key)) return this._loops.get(key);

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate;

    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(volume, this.ctx.currentTime, fadeIn);

    let panner = null;
    const destBus = bus === 'ui' ? this.uiBus : bus === 'ambient' ? this.ambientBus : this.sfxBus;
    if (position) {
      panner = this._makePanner(position, refDistance, rolloff, maxDistance);
      src.connect(gain);
      gain.connect(panner);
      panner.connect(destBus);
    } else {
      src.connect(gain);
      gain.connect(destBus);
    }
    src.start();

    const handle = {
      src, gain, panner,
      setPosition: (p) => {
        if (!panner) return;
        if (panner.positionX) {
          const t = this.ctx.currentTime;
          panner.positionX.setTargetAtTime(p.x, t, 0.02);
          panner.positionY.setTargetAtTime(p.y, t, 0.02);
          panner.positionZ.setTargetAtTime(p.z, t, 0.02);
        } else {
          panner.setPosition(p.x, p.y, p.z);
        }
      },
      setVolume: (v, time = 0.1) => gain.gain.setTargetAtTime(v, this.ctx.currentTime, time),
      setRate: (r, time = 0.1) => src.playbackRate.setTargetAtTime(r, this.ctx.currentTime, time),
      stop: (fade = 0.3) => {
        gain.gain.setTargetAtTime(0, this.ctx.currentTime, fade);
        setTimeout(() => { try { src.stop(); } catch { /* already stopped */ } }, fade * 4000);
        this._loops.delete(key);
      },
    };
    this._loops.set(key, handle);
    return handle;
  }

  getLoop(key) {
    return this._loops.get(key) || null;
  }

  stopLoop(key, fade = 0.3) {
    this._loops.get(key)?.stop(fade);
  }

  stopAllLoops() {
    for (const k of [...this._loops.keys()]) this.stopLoop(k, 0.1);
  }

  /** Footstep helper: picks the right surface variant and randomises pitch. */
  playFootstep(surface, position, { crouch = false, sprint = false } = {}) {
    let id = `step.${surface}`;
    if (!this.buffers.has(id)) id = 'step.grass';
    // Alternate variants where available for a natural left/right cadence.
    if (this.buffers.has(id + '2') && Math.random() > 0.5) id += '2';
    const volume = crouch ? 0.25 : sprint ? 1.0 : 0.7;
    this.play(id, {
      position,
      volume,
      rate: 0.92 + Math.random() * 0.16,
      refDistance: 2,
      rolloff: 2.6,
      maxDistance: 120,
    });
  }

  setVolume(channel, value) {
    this.volumes[channel] = value;
    if (!this.ready) return;
    if (channel === 'master') this.master.gain.value = value;
    if (channel === 'sfx') this.sfxBus.gain.value = value;
    if (channel === 'ui') this.uiBus.gain.value = value;
    if (channel === 'ambient') this.ambientBus.gain.value = value;
  }

  setMuted(v) {
    this.muted = v;
    if (this.ready) this.master.gain.value = v ? 0 : this.volumes.master;
  }

  suspend() { this.ctx?.suspend(); }
  resume() { this.ctx?.resume(); }
}

export const audio = new AudioEngine();
export default audio;
export { BANK, LOOPING };
