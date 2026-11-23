// Sounds, made on the spot with Web Audio (no files): a gunshot is a burst of
// noise, bright at first and darkening as it dies away, over a low thump. The
// audio context starts on the first sound (after a click, so the browser
// allows it).

let ctx: AudioContext | undefined;
let noise: AudioBuffer | undefined;

/** A pistol shot, now. */
export function gunshot(): void {
  ctx ??= new AudioContext();
  const c = ctx, t = c.currentTime;
  if (!noise) {
    noise = c.createBuffer(1, Math.round(c.sampleRate * 0.6), c.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  // The crack: noise through a low-pass that closes, fading fast.
  const crack = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
  crack.buffer = noise;
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(9000, t);
  filter.frequency.exponentialRampToValueAtTime(400, t + 0.35);
  gain.gain.setValueAtTime(0.9, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
  crack.connect(filter).connect(gain).connect(c.destination);
  crack.start(t);
  crack.stop(t + 0.5);
  // The thump: a low tone dropping in pitch.
  const thump = c.createOscillator(), tg = c.createGain();
  thump.frequency.setValueAtTime(140, t);
  thump.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  tg.gain.setValueAtTime(0.7, t);
  tg.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
  thump.connect(tg).connect(c.destination);
  thump.start(t);
  thump.stop(t + 0.2);
}
