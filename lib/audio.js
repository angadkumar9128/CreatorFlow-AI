/**
 * lib/audio.js — procedural score generator.
 *
 * Every reel gets a different track. Genre comes from the niche, then a seed
 * picks the key, tempo, chord progression, drum pattern and arp figure inside
 * that genre. Nothing is sampled, so there is no copyright surface at all and
 * no files to ship — it is all synthesised with Web Audio oscillators and
 * filtered noise at render time.
 *
 * Exports:
 *   pickGenre(niche, seed)
 *   buildScore(audioCtx, opts) -> { output, stop, bpm, genre, key }
 *   GENRES
 */

/* ── deterministic randomness ──────────────────────────── */

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const rng = mulberry32(seed >>> 0);
  return {
    next: rng,
    range: (lo, hi) => lo + rng() * (hi - lo),
    int: (lo, hi) => Math.floor(lo + rng() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(rng() * arr.length)],
    chance: (p) => rng() < p,
  };
}

/* ── musical vocabulary ────────────────────────────────── */

const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

const PROGRESSIONS = {
  minor: [
    [0, 5, 3, 4],
    [0, 3, 4, 3],
    [0, 6, 3, 4],
    [5, 3, 0, 4],
    [0, 4, 5, 3],
  ],
  major: [
    [0, 4, 5, 3],
    [0, 3, 4, 4],
    [5, 3, 0, 4],
    [0, 5, 3, 4],
    [3, 4, 0, 0],
  ],
  dorian: [
    [0, 3, 0, 6],
    [0, 6, 3, 4],
    [0, 4, 3, 0],
  ],
  phrygian: [
    [0, 1, 0, 6],
    [0, 6, 1, 0],
  ],
  mixolydian: [
    [0, 6, 3, 4],
    [0, 4, 6, 0],
  ],
};

// 16-step patterns. 1 = hit, 2 = accent, 0 = rest.
const KICKS = {
  four: [2, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0],
  boom: [2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0, 0],
  trap: [2, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0],
  broken: [2, 0, 0, 1, 0, 0, 1, 0, 2, 0, 0, 0, 0, 1, 0, 0],
  sparse: [2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
  drive: [2, 0, 1, 0, 1, 0, 0, 1, 2, 0, 1, 0, 1, 0, 1, 0],
};

const SNARES = {
  backbeat: [0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0],
  halftime: [0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1],
  clapGhost: [0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 2, 0, 0, 1],
  none: new Array(16).fill(0),
};

const HATS = {
  eighths: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
  sixteenths: new Array(16).fill(1),
  offbeat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
  rolls: [1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1],
  swung: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
  none: new Array(16).fill(0),
};

const ARPS = {
  up: [0, 1, 2, 3],
  updown: [0, 1, 2, 1],
  wide: [0, 2, 4, 2],
  stab: [0, 0, 2, 0],
  rolling: [0, 2, 1, 3, 2, 4, 3, 5],
  none: null,
};

/**
 * Each genre is a bundle of ranges and pattern pools, not fixed values —
 * that's what stops two reels in the same niche sounding the same.
 */
export const GENRES = {
  cinematic: {
    label: "Cinematic build",
    bpm: [76, 92],
    scale: ["minor", "phrygian"],
    kicks: ["boom", "sparse"],
    snares: ["halftime", "none"],
    hats: ["none", "offbeat"],
    arps: ["none", "wide"],
    padLevel: 0.34,
    bassLevel: 0.3,
    drumLevel: 0.46,
    padWave: "sawtooth",
    padCutoff: [420, 900],
    bassWave: "triangle",
    riser: true,
    sub: true,
  },
  synthwave: {
    label: "Synthwave",
    bpm: [104, 118],
    scale: ["minor", "dorian"],
    kicks: ["four", "drive"],
    snares: ["backbeat"],
    hats: ["offbeat", "eighths"],
    arps: ["up", "rolling", "updown"],
    padLevel: 0.24,
    bassLevel: 0.34,
    drumLevel: 0.4,
    padWave: "sawtooth",
    padCutoff: [900, 1700],
    bassWave: "sawtooth",
    riser: true,
    sub: false,
  },
  lofi: {
    label: "Lo-fi",
    bpm: [70, 84],
    scale: ["dorian", "minor"],
    kicks: ["broken", "sparse"],
    snares: ["clapGhost"],
    hats: ["swung", "eighths"],
    arps: ["stab", "updown"],
    padLevel: 0.3,
    bassLevel: 0.28,
    drumLevel: 0.3,
    padWave: "triangle",
    padCutoff: [520, 980],
    bassWave: "sine",
    riser: false,
    sub: false,
    swing: 0.16,
  },
  trap: {
    label: "Trap",
    bpm: [130, 148],
    scale: ["minor", "phrygian"],
    kicks: ["trap"],
    snares: ["halftime"],
    hats: ["rolls", "sixteenths"],
    arps: ["stab", "none"],
    padLevel: 0.18,
    bassLevel: 0.44,
    drumLevel: 0.5,
    padWave: "triangle",
    padCutoff: [600, 1100],
    bassWave: "sine",
    riser: true,
    sub: true,
  },
  house: {
    label: "House",
    bpm: [118, 126],
    scale: ["minor", "major"],
    kicks: ["four"],
    snares: ["backbeat", "clapGhost"],
    hats: ["offbeat", "sixteenths"],
    arps: ["rolling", "up"],
    padLevel: 0.26,
    bassLevel: 0.32,
    drumLevel: 0.42,
    padWave: "sawtooth",
    padCutoff: [800, 1600],
    bassWave: "sawtooth",
    riser: true,
    sub: false,
  },
  acoustic: {
    label: "Warm acoustic",
    bpm: [82, 96],
    scale: ["major", "mixolydian"],
    kicks: ["sparse", "broken"],
    snares: ["clapGhost", "none"],
    hats: ["swung", "offbeat"],
    arps: ["up", "updown"],
    padLevel: 0.3,
    bassLevel: 0.26,
    drumLevel: 0.28,
    padWave: "triangle",
    padCutoff: [700, 1300],
    bassWave: "sine",
    riser: false,
    sub: false,
  },
  uplift: {
    label: "Uplifting pop",
    bpm: [98, 114],
    scale: ["major", "mixolydian"],
    kicks: ["four", "drive"],
    snares: ["backbeat"],
    hats: ["eighths", "sixteenths"],
    arps: ["up", "wide", "rolling"],
    padLevel: 0.28,
    bassLevel: 0.3,
    drumLevel: 0.4,
    padWave: "sawtooth",
    padCutoff: [1000, 1900],
    bassWave: "triangle",
    riser: true,
    sub: false,
  },
  tension: {
    label: "Dark tension",
    bpm: [86, 100],
    scale: ["phrygian", "minor"],
    kicks: ["sparse", "boom"],
    snares: ["none", "halftime"],
    hats: ["offbeat", "none"],
    arps: ["stab", "none"],
    padLevel: 0.38,
    bassLevel: 0.34,
    drumLevel: 0.34,
    padWave: "sawtooth",
    padCutoff: [300, 700],
    bassWave: "triangle",
    riser: true,
    sub: true,
  },
  corporate: {
    label: "Clean drive",
    bpm: [104, 116],
    scale: ["major", "dorian"],
    kicks: ["four", "drive"],
    snares: ["backbeat"],
    hats: ["eighths", "offbeat"],
    arps: ["up", "stab"],
    padLevel: 0.22,
    bassLevel: 0.28,
    drumLevel: 0.36,
    padWave: "triangle",
    padCutoff: [900, 1500],
    bassWave: "triangle",
    riser: false,
    sub: false,
  },
};

const NICHE_GENRES = {
  motivation: ["cinematic", "uplift", "trap"],
  fitness: ["trap", "cinematic", "house"],
  technology: ["synthwave", "corporate", "house"],
  business: ["corporate", "uplift", "house"],
  finance: ["corporate", "trap", "cinematic"],
  agriculture: ["acoustic", "uplift", "lofi"],
  food: ["lofi", "acoustic", "house"],
  travel: ["uplift", "acoustic", "house"],
  fashion: ["house", "synthwave", "uplift"],
  creative: ["lofi", "synthwave", "acoustic"],
  learning: ["lofi", "corporate", "acoustic"],
  facts: ["tension", "cinematic", "synthwave"],
  mystery: ["tension", "cinematic"],
};

export function pickGenre(niche, seed = 0) {
  const pool = NICHE_GENRES[niche] || ["uplift", "lofi", "cinematic", "synthwave"];
  return pool[Math.abs(seed) % pool.length];
}

/* ── synthesis primitives ──────────────────────────────── */

function noiseBuffer(ctx, seconds = 1) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function env(param, t, { attack = 0.004, peak = 1, decay = 0.2, sustain = 0, hold = 0, release = 0.05 }) {
  param.cancelScheduledValues(t);
  param.setValueAtTime(0.0001, t);
  param.exponentialRampToValueAtTime(Math.max(0.0001, peak), t + attack);
  if (hold) param.setValueAtTime(Math.max(0.0001, peak), t + attack + hold);
  const decayStart = t + attack + hold;
  param.exponentialRampToValueAtTime(Math.max(0.0001, sustain || 0.0001), decayStart + decay);
  if (release) param.exponentialRampToValueAtTime(0.0001, decayStart + decay + release);
}

function kick(ctx, dest, t, level, sub) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(sub ? 150 : 128, t);
  osc.frequency.exponentialRampToValueAtTime(sub ? 36 : 46, t + 0.13);
  env(gain.gain, t, { attack: 0.002, peak: level, decay: sub ? 0.42 : 0.28, release: 0.04 });
  osc.connect(gain).connect(dest);
  osc.start(t);
  osc.stop(t + 0.7);

  // A tiny click gives the kick definition on phone speakers.
  const click = ctx.createOscillator();
  const cg = ctx.createGain();
  click.type = "square";
  click.frequency.setValueAtTime(1100, t);
  env(cg.gain, t, { attack: 0.001, peak: level * 0.14, decay: 0.012, release: 0.005 });
  click.connect(cg).connect(dest);
  click.start(t);
  click.stop(t + 0.05);
}

function snare(ctx, dest, t, level, noise) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1750;
  bp.Q.value = 0.8;
  const gain = ctx.createGain();
  env(gain.gain, t, { attack: 0.002, peak: level, decay: 0.16, release: 0.03 });
  src.connect(bp).connect(gain).connect(dest);
  src.start(t);
  src.stop(t + 0.35);

  const body = ctx.createOscillator();
  const bg = ctx.createGain();
  body.type = "triangle";
  body.frequency.setValueAtTime(190, t);
  body.frequency.exponentialRampToValueAtTime(130, t + 0.08);
  env(bg.gain, t, { attack: 0.002, peak: level * 0.45, decay: 0.09, release: 0.02 });
  body.connect(bg).connect(dest);
  body.start(t);
  body.stop(t + 0.2);
}

function hat(ctx, dest, t, level, noise, open = false) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 7200;
  const gain = ctx.createGain();
  env(gain.gain, t, { attack: 0.001, peak: level, decay: open ? 0.16 : 0.035, release: 0.01 });
  src.connect(hp).connect(gain).connect(dest);
  src.start(t);
  src.stop(t + 0.3);
}

function bassNote(ctx, dest, t, freq, dur, level, wave) {
  const osc = ctx.createOscillator();
  const lp = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  osc.type = wave;
  osc.frequency.setValueAtTime(freq, t);
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(320, t);
  lp.frequency.linearRampToValueAtTime(190, t + dur);
  lp.Q.value = 3;
  env(gain.gain, t, {
    attack: 0.012,
    peak: level,
    decay: dur * 0.5,
    sustain: level * 0.45,
    release: 0.09,
  });
  osc.connect(lp).connect(gain).connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.2);
}

function padChord(ctx, dest, t, freqs, dur, level, wave, cutoff) {
  const lp = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(cutoff * 0.6, t);
  lp.frequency.linearRampToValueAtTime(cutoff, t + dur * 0.6);
  lp.Q.value = 0.7;
  env(gain.gain, t, {
    attack: dur * 0.22,
    peak: level,
    decay: dur * 0.3,
    sustain: level * 0.7,
    release: dur * 0.35,
  });
  lp.connect(gain).connect(dest);

  freqs.forEach((f, i) => {
    // Two slightly detuned voices per note is what makes a pad sound wide.
    [-5, 5].forEach((cents) => {
      const osc = ctx.createOscillator();
      osc.type = wave;
      osc.frequency.value = f * Math.pow(2, cents / 1200);
      const vg = ctx.createGain();
      vg.gain.value = 1 / (freqs.length * 2.2) / (1 + i * 0.12);
      osc.connect(vg).connect(lp);
      osc.start(t);
      osc.stop(t + dur + 0.6);
    });
  });
}

function pluck(ctx, dest, t, freq, level, decay = 0.28) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  osc.type = "triangle";
  osc.frequency.value = freq;
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(4200, t);
  lp.frequency.exponentialRampToValueAtTime(900, t + decay);
  env(gain.gain, t, { attack: 0.004, peak: level, decay, release: 0.04 });
  osc.connect(lp).connect(gain).connect(dest);
  osc.start(t);
  osc.stop(t + decay + 0.3);
}

function riser(ctx, dest, t, dur, level, noise) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 2.2;
  bp.frequency.setValueAtTime(380, t);
  bp.frequency.exponentialRampToValueAtTime(7200, t + dur);
  const gain = ctx.createGain();
  env(gain.gain, t, { attack: dur * 0.85, peak: level, decay: 0.06, release: 0.12 });
  src.connect(bp).connect(gain).connect(dest);
  src.start(t);
  src.stop(t + dur + 0.3);
}

function impact(ctx, dest, t, level, noise) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(110, t);
  osc.frequency.exponentialRampToValueAtTime(32, t + 0.5);
  env(g.gain, t, { attack: 0.003, peak: level, decay: 0.7, release: 0.15 });
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + 1.3);

  const src = ctx.createBufferSource();
  src.buffer = noise;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(2600, t);
  lp.frequency.exponentialRampToValueAtTime(320, t + 0.4);
  const ng = ctx.createGain();
  env(ng.gain, t, { attack: 0.002, peak: level * 0.6, decay: 0.35, release: 0.08 });
  src.connect(lp).connect(ng).connect(dest);
  src.start(t);
  src.stop(t + 0.9);
}

/** Transition whoosh. Direction flips the stereo sweep. */
function whoosh(ctx, dest, t, dur, level, noise, direction = 1) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.4;
  bp.frequency.setValueAtTime(direction > 0 ? 600 : 4800, t);
  bp.frequency.exponentialRampToValueAtTime(direction > 0 ? 4800 : 600, t + dur);

  const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (panner) {
    panner.pan.setValueAtTime(-0.75 * direction, t);
    panner.pan.linearRampToValueAtTime(0.75 * direction, t + dur);
  }

  const gain = ctx.createGain();
  env(gain.gain, t, { attack: dur * 0.45, peak: level, decay: dur * 0.5, release: 0.05 });

  src.connect(bp);
  if (panner) {
    bp.connect(panner);
    panner.connect(gain);
  } else {
    bp.connect(gain);
  }
  gain.connect(dest);

  src.start(t);
  src.stop(t + dur + 0.2);
}

/* ── the score ─────────────────────────────────────────── */

/**
 * Schedules a whole track. Returns the node to connect into your recording
 * destination. Everything is scheduled up front, so it stays in sync with the
 * canvas even if a frame drops.
 */
export function buildScore(ctx, opts = {}) {
  const {
    seconds = 14,
    niche = "motivation",
    seed = Math.floor(Math.random() * 1e9),
    startAt = ctx.currentTime + 0.12,
    volume = 0.85,
    genre: forcedGenre,
    cuts = [], // scene boundary times, for whooshes
    accents = [], // caption pop times, for ticks
    intensity = 1,
  } = opts;

  const rng = makeRng(seed);
  const genreKey = forcedGenre && GENRES[forcedGenre] ? forcedGenre : pickGenre(niche, seed);
  const g = GENRES[genreKey];

  const bpm = Math.round(rng.range(g.bpm[0], g.bpm[1]));
  const beat = 60 / bpm;
  const step = beat / 4;
  const bar = beat * 4;
  const bars = Math.max(2, Math.ceil((seconds + 0.6) / bar));

  const scaleName = rng.pick(g.scale);
  const scale = SCALES[scaleName];
  const progression = rng.pick(PROGRESSIONS[scaleName] || PROGRESSIONS.minor);
  const rootSemi = rng.int(-4, 5); // key change, ±a few semitones
  const rootHz = 55 * Math.pow(2, rootSemi / 12); // around A1

  const kickPat = KICKS[rng.pick(g.kicks)];
  const snarePat = SNARES[rng.pick(g.snares)];
  const hatPat = HATS[rng.pick(g.hats)];
  const arpPat = ARPS[rng.pick(g.arps)];
  const swing = g.swing || 0;

  const noise = noiseBuffer(ctx, 2);

  // master chain: bus -> gentle compression -> output
  const bus = ctx.createGain();
  bus.gain.value = 1;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 24;
  comp.ratio.value = 4;
  comp.attack.value = 0.004;
  comp.release.value = 0.2;

  const master = ctx.createGain();
  master.gain.value = volume;

  bus.connect(comp).connect(master);

  const drumBus = ctx.createGain();
  drumBus.gain.value = g.drumLevel * intensity;
  drumBus.connect(bus);

  const toneBus = ctx.createGain();
  toneBus.gain.value = 1;
  toneBus.connect(bus);

  const noteAt = (degree, octave) => {
    const oct = Math.floor(degree / scale.length) + octave;
    const semi = scale[((degree % scale.length) + scale.length) % scale.length];
    return rootHz * Math.pow(2, oct + semi / 12);
  };

  const buildTriad = (rootDegree) => [
    noteAt(rootDegree, 2),
    noteAt(rootDegree + 2, 2),
    noteAt(rootDegree + 4, 2),
    ...(rng.chance(0.4) ? [noteAt(rootDegree + 6, 2)] : []), // occasional 7th
  ];

  // Structure: bar 0 is intro (no drums), the last bar builds.
  const introBars = bars > 3 ? 1 : 0;
  const lastBar = bars - 1;

  for (let b = 0; b < bars; b++) {
    const barTime = startAt + b * bar;
    const chordDegree = progression[b % progression.length];
    const chordFreqs = buildTriad(chordDegree);
    const isIntro = b < introBars;
    const isFinal = b === lastBar;

    padChord(
      ctx,
      toneBus,
      barTime,
      chordFreqs,
      bar * 0.98,
      g.padLevel * (isIntro ? 0.7 : 1) * intensity,
      g.padWave,
      rng.range(g.padCutoff[0], g.padCutoff[1])
    );

    for (let s = 0; s < 16; s++) {
      const swungOffset = swing && s % 2 === 1 ? step * swing : 0;
      const t = barTime + s * step + swungOffset;
      if (t > startAt + seconds + 0.4) break;

      if (!isIntro) {
        if (kickPat[s]) kick(ctx, drumBus, t, kickPat[s] === 2 ? 0.95 : 0.62, g.sub);
        if (snarePat[s]) snare(ctx, drumBus, t, snarePat[s] === 2 ? 0.44 : 0.2, noise);
        if (hatPat[s]) {
          const open = s % 8 === 6 && rng.chance(0.35);
          hat(ctx, drumBus, t, open ? 0.2 : rng.range(0.1, 0.19), noise, open);
        }
      }

      // Bass follows the chord root, with a couple of passing notes.
      if (s % 4 === 0 && !isIntro) {
        const deg = s === 8 && rng.chance(0.35) ? chordDegree + 4 : chordDegree;
        bassNote(ctx, toneBus, t, noteAt(deg, 0), beat * 0.9, g.bassLevel * intensity, g.bassWave);
      }

      // Arpeggio on top.
      if (arpPat && s % 2 === 0) {
        const idx = (s / 2) % arpPat.length;
        const deg = chordDegree + arpPat[idx];
        pluck(ctx, toneBus, t, noteAt(deg, 3), (isIntro ? 0.1 : 0.17) * intensity, step * 2.2);
      }
    }

    // Build into the payoff.
    if (g.riser && isFinal && bars > 2) {
      riser(ctx, toneBus, barTime, bar * 0.9, 0.16 * intensity, noise);
    }
  }

  // Opening impact so the reel lands hard on frame one.
  impact(ctx, toneBus, startAt, 0.5 * intensity, noise);

  // Whooshes on every scene change — this is what makes cuts feel deliberate.
  cuts.forEach((cutTime, i) => {
    const t = startAt + cutTime - 0.26;
    if (t <= startAt || cutTime > seconds) return;
    whoosh(ctx, toneBus, t, 0.44, 0.2 * intensity, noise, i % 2 === 0 ? 1 : -1);
    if (i % 2 === 1) impact(ctx, toneBus, startAt + cutTime, 0.26 * intensity, noise);
  });

  // Soft ticks under caption pops.
  accents.forEach((a) => {
    const t = startAt + a;
    if (a > seconds) return;
    hat(ctx, drumBus, t, 0.12 * intensity, noise, false);
  });

  // Fade the whole thing out at the end rather than cutting it dead.
  const endAt = startAt + seconds;
  master.gain.setValueAtTime(volume, Math.max(startAt, endAt - 0.75));
  master.gain.exponentialRampToValueAtTime(0.0001, endAt);

  return {
    output: master,
    bpm,
    beat,
    genre: genreKey,
    genreLabel: g.label,
    key: `${scaleName} ${rootSemi >= 0 ? "+" : ""}${rootSemi}`,
    stop() {
      try {
        master.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}
