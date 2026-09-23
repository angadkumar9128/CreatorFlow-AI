export const MIN_SOURCE_SECONDS = 30;
export const MAX_SOURCE_SECONDS = 30 * 60;
export const DEFAULT_SHORT_SECONDS = 30;
export const MIN_EDIT_SECONDS = 3;
export const MAX_EDIT_SECONDS = 180;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function validateSourceDuration(seconds) {
  const duration = Number(seconds);
  if (!Number.isFinite(duration)) return { ok: false, error: "Could not read the uploaded video's duration." };
  if (duration < MIN_SOURCE_SECONDS) return { ok: false, error: `Source video must be at least ${MIN_SOURCE_SECONDS} seconds long.` };
  if (duration > MAX_SOURCE_SECONDS) return { ok: false, error: "Source video cannot be longer than 30 minutes." };
  return { ok: true, duration };
}

function id(prefix, index) {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${prefix}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
}

function state(base) {
  return {
    id: base.id, index: base.index,
    sourceStart: base.sourceStart, sourceEnd: base.sourceEnd,
    videoStart: base.sourceStart, videoEnd: base.sourceEnd,
    duration: base.sourceEnd - base.sourceStart,
    originalVolume: 1, music: null,
    renderStatus: "idle", renderProgress: 0,
    outputUrl: null, renderedBlob: null, selected: false, error: "",
  };
}

export function createRegularShorts(sourceDuration, shortDuration = DEFAULT_SHORT_SECONDS) {
  const total = Number(sourceDuration) || 0;
  const length = clamp(Number(shortDuration) || DEFAULT_SHORT_SECONDS, MIN_EDIT_SECONDS, MAX_EDIT_SECONDS);
  const count = Math.floor(total / length);
  return Array.from({ length: count }, (_, i) => {
    const start = i * length;
    return state({ id: id("regular", i + 1), index: i + 1, sourceStart: start, sourceEnd: start + length });
  });
}

export function createRandomShorts(sourceDuration, shortDuration = DEFAULT_SHORT_SECONDS, seed = Date.now()) {
  const total = Number(sourceDuration) || 0;
  const length = clamp(Number(shortDuration) || DEFAULT_SHORT_SECONDS, MIN_EDIT_SECONDS, MAX_EDIT_SECONDS);
  const count = Math.floor(total / length);
  if (!count) return [];
  const rand = mulberry32(Number(seed) || 1);
  const slots = Array.from({ length: count }, (_, i) => i);
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  return slots.map((slot, i) => {
    const start = slot * length;
    return state({ id: id("random", i + 1), index: i + 1, sourceStart: start, sourceEnd: start + length });
  });
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
