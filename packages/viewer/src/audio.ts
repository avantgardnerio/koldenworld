// Sounds, made on the spot with Web Audio (no files): a gunshot is a burst of
// noise, bright at first and darkening as it dies away, over a low thump; a
// rifle's is sharper, louder and rings on longer. The audio context starts on
// the first sound (after a click, so the browser allows it).

let ctx: AudioContext | undefined;
let noise: AudioBuffer | undefined;

/** How each gun sounds: loudness, how bright the crack starts (Hz), how long it rings (s), the thump's pitch (Hz). */
const SHOT = {
  pistol: { gain: 0.9, bright: 9000, ring: 0.45, thump: 140 },
  rifle: { gain: 1.0, bright: 14000, ring: 0.7, thump: 110 },
} as const;

/** A shot from a gun, now. */
export function gunshot(gun: "pistol" | "rifle" = "pistol"): void {
  const s = SHOT[gun];
  ctx ??= new AudioContext();
  const c = ctx, t = c.currentTime;
  if (!noise) {
    noise = c.createBuffer(1, Math.round(c.sampleRate * 0.8), c.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  // The crack: noise through a low-pass that closes, fading fast.
  const crack = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
  crack.buffer = noise;
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(s.bright, t);
  filter.frequency.exponentialRampToValueAtTime(400, t + s.ring * 0.8);
  gain.gain.setValueAtTime(s.gain, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + s.ring);
  crack.connect(filter).connect(gain).connect(c.destination);
  crack.start(t);
  crack.stop(t + s.ring + 0.05);
  // The thump: a low tone dropping in pitch.
  const thump = c.createOscillator(), tg = c.createGain();
  thump.frequency.setValueAtTime(s.thump, t);
  thump.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  tg.gain.setValueAtTime(0.7, t);
  tg.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
  thump.connect(tg).connect(c.destination);
  thump.start(t);
  thump.stop(t + 0.2);
}
