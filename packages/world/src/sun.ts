// The sun, with no night: where it really is in the sky while the sun is really up, and through the real night the
// day's arc again (sunrise to sunset, stretched or squeezed to fit the night), so it rises again as soon as it sets
// and is back where it really is at the real sunrise. Direct sunlight fades out toward the horizon, so the jump from
// sunset back to sunrise has no light to flip.
//
// The real position is NOAA's general solar position (declination and equation of time from the fractional year;
// about 0.1°, plenty for lighting). The sun's hour angle, its angle west of the local meridian, is what's remapped:
// within ±H0 (the hour angle of sunset) it's real; outside, the night's share of the turn maps back onto −H0..H0.
// Polar day keeps the real sun all day; polar night (no real daylight) uses an equinox arc.

/** Degrees of elevation over which direct sunlight fades in from the horizon. */
export const SUN_FADE_DEG = 10;

const DEG = Math.PI / 180;

export interface SunState {
  /** Unit vector toward the sun in the local east-north-up frame. */
  direction: [east: number, north: number, up: number];
  /** Degrees above the horizon (never below 0 here). */
  elevation: number;
  /** 0 at the horizon to 1 from SUN_FADE_DEG up: how much direct light there is. */
  strength: number;
  /** Whether this is the real sun (the real day), not the night's replay of it. */
  real: boolean;
}

/** The sun over (lat, lon) at `time`, with the night skipped as described above. */
export function sunNoNight(time: Date, lat: number, lon: number): SunState {
  const { declination, hourAngle } = solarAngles(time, lon);
  const phi = lat * DEG;
  // Sunset's hour angle: where the sun's center crosses the horizon.
  const cosH0 = -Math.tan(phi) * Math.tan(declination);
  let h = hourAngle, decl = declination, real = true;
  if (cosH0 <= -1) {
    // Polar day: the real sun, all day.
  } else {
    // Polar night has no real day to replay: an equinox day (sunrise and sunset at ±90°, no declination) instead.
    const polarNight = cosH0 >= 1;
    const h0 = polarNight ? Math.PI / 2 : Math.acos(cosH0);
    if (polarNight) decl = 0;
    if (polarNight) {
      // The whole turn onto the arc: sunrise at the real midnight, noon at the real noon.
      h = -h0 + (2 * h0 * (h + Math.PI)) / (2 * Math.PI);
      real = false;
    } else if (Math.abs(h) > h0) {
      // Hour angle in −π..π; outside ±h0 it's night: how far through the night, onto the day's arc.
      const intoNight = ((h - h0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      h = -h0 + (2 * h0 * intoNight) / (2 * Math.PI - 2 * h0);
      real = false;
    }
  }
  const [east, north, up] = direction(phi, decl, h);
  const elevation = Math.max(0, Math.asin(Math.max(-1, Math.min(1, up))) / DEG);
  return {
    direction: [east, north, Math.max(0, up)],
    elevation,
    strength: Math.min(1, elevation / SUN_FADE_DEG),
    real,
  };
}

/** The real sun's declination and hour angle (radians, hour angle −π..π, positive west of the meridian). */
export function solarAngles(time: Date, lon: number): { declination: number; hourAngle: number } {
  const start = Date.UTC(time.getUTCFullYear(), 0, 1);
  const days = (time.getTime() - start) / 86_400_000;  // since the year began, fractional
  const leap = new Date(Date.UTC(time.getUTCFullYear(), 1, 29)).getUTCMonth() === 1;
  const g = (2 * Math.PI / (leap ? 366 : 365)) * days;  // fractional year
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));  // minutes
  const declination = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const utcMinutes = time.getUTCHours() * 60 + time.getUTCMinutes() + time.getUTCSeconds() / 60
    + time.getUTCMilliseconds() / 60_000;
  const solarMinutes = utcMinutes + eqTime + 4 * lon;  // true solar time
  const hourAngle = ((((solarMinutes / 4 - 180) % 360) + 540) % 360 - 180) * DEG;
  return { declination, hourAngle };
}

/** The unit vector toward a body at declination `decl` and hour angle `h`, seen from latitude `phi` (radians), ENU. */
function direction(phi: number, decl: number, h: number): [number, number, number] {
  const up = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(h);
  const east = -Math.cos(decl) * Math.sin(h);
  const north = Math.cos(phi) * Math.sin(decl) - Math.sin(phi) * Math.cos(decl) * Math.cos(h);
  return [east, north, up];
}
