export const MIN_SOURCE_SECONDS = 30;
export const MAX_SOURCE_SECONDS = 30 * 60;
export const DEFAULT_SHORT_SECONDS = 30;
export const MIN_EDIT_SECONDS = 3;
export const MAX_EDIT_SECONDS = 180;

export function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function validateSourceDuration(seconds) {
  const duration = Number(seconds);
  if (!Number.isFinite(duration)) return { ok: false, error: "Could not read the uploaded video's duration." };
  if (duration < MIN_SOURCE_SECONDS) return { ok: false, error: `Source video must be at least ${MIN_SOURCE_SECONDS} seconds long.` };
  if (duration > MAX_SOURCE_SECONDS) return { ok: false, error: "Source video cannot be longer than 30 minutes." };
  return { ok: true, duration };
}

function makeId(prefix, index) {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${prefix}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
}

function makeState(base) {
  return {
    id: base.id, index: base.index, sourceStart: base.sourceStart, sourceEnd: base.sourceEnd,
    videoStart: base.sourceStart, videoEnd: base.sourceEnd, duration: base.sourceEnd - base.sourceStart,
    originalVolume: 1, music: null, renderStatus: "idle", renderProgress: 0,
    outputUrl: null, renderedBlob: null, selected: false, error: "",
  };
}

export function createRegularShorts(sourceDuration, shortDuration = DEFAULT_SHORT_SECONDS) {
  const total = Number(sourceDuration) || 0;
  const length = clamp(Number(shortDuration) || DEFAULT_SHORT_SECONDS, MIN_EDIT_SECONDS, MAX_EDIT_SECONDS);
  const count = Math.floor(total / length);
  return Array.from({ length: count }, (_, i) => {
    const start = i * length;
    return makeState({ id: makeId("regular", i + 1), index: i + 1, sourceStart: start, sourceEnd: start + length });
  });
}

export function createRandomShorts(sourceDuration, shortDuration = DEFAULT_SHORT_SECONDS, seed = Date.now()) {
  const total = Number(sourceDuration) || 0;
  const length = clamp(Number(shortDuration) || DEFAULT_SHORT_SECONDS, MIN_EDIT_SECONDS, MAX_EDIT_SECONDS);
  const count = Math.floor(total / length);
  if (!count) return [];
  const rand = mulberry32(Number(seed) || 1);
  const spare = Math.max(0, total - count * length);
  const gaps = randomComposition(spare, count + 1, rand);
  const ranges = [];
  let cursor = gaps[0];
  for (let i = 0; i < count; i++) {
    ranges.push({ start: cursor, end: cursor + length });
    cursor += length + gaps[i + 1];
  }
  for (let i = ranges.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ranges[i], ranges[j]] = [ranges[j], ranges[i]];
  }
  return ranges.map((range, i) => makeState({
    id: makeId("random", i + 1), index: i + 1, sourceStart: range.start, sourceEnd: range.end,
  }));
}

function randomComposition(total, parts, rand) {
  if (parts <= 1) return [total];
  if (total <= 0) return new Array(parts).fill(0);
  const weights = Array.from({ length: parts }, () => Math.max(.0001, rand()));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => total * w / sum);
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
