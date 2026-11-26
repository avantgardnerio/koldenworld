import { describe, expect, it } from "vitest";
import { sunNoNight } from "../src/index.ts";

const DENVER = { lat: 39.74, lon: -104.99 };
const at = (iso: string, { lat, lon } = DENVER) => sunNoNight(new Date(iso), lat, lon);

describe("sunNoNight", () => {
  it("is the real sun by day", () => {
    // Denver, the June solstice near solar noon (19:00 UTC): ~73.6° up, due south.
    const s = at("2026-06-21T19:00:00Z");
    expect(s.real).toBe(true);
    expect(s.elevation).toBeGreaterThan(72);
    expect(s.elevation).toBeLessThan(75);
    expect(Math.abs(s.direction[0])).toBeLessThan(0.05);  // hardly east or west
    expect(s.direction[1]).toBeLessThan(0);                // south
    expect(s.strength).toBe(1);
    // Mid-morning: in the east, partway up.
    const morning = at("2026-06-21T15:00:00Z");
    expect(morning.real).toBe(true);
    expect(morning.direction[0]).toBeGreaterThan(0.5);
  });

  it("never sets: through the night the day's arc again, ending where the real sunrise is", () => {
    for (let hour = 0; hour < 24; hour += 0.25) {
      const s = at(new Date(Date.UTC(2026, 11, 21, 0, hour * 60)).toISOString());
      expect(s.elevation).toBeGreaterThanOrEqual(0);
      expect(Math.hypot(...s.direction)).toBeCloseTo(1, 6);
    }
    // Real midnight (07:00 UTC is about 00:00 local solar time in Denver): the replay is mid-arc, high in the south.
    const midnight = at("2026-06-21T07:00:00Z");
    expect(midnight.real).toBe(false);
    expect(midnight.elevation).toBeGreaterThan(60);
    // Just before the real sunrise, the replay is setting in the west; just after, the real sun rises in the east.
    const before = at("2026-06-21T11:25:00Z"), after = at("2026-06-21T11:40:00Z");
    expect(before.real).toBe(false);
    expect(before.direction[0]).toBeLessThan(0);
    expect(before.strength).toBeLessThan(0.5);
    expect(after.real).toBe(true);
    expect(after.direction[0]).toBeGreaterThan(0);
    expect(after.strength).toBeLessThan(0.5);
  });

  it("keeps the real sun through polar day and an equinox arc through polar night", () => {
    const tromso = { lat: 69.65, lon: 18.96 };
    expect(at("2026-06-21T23:00:00Z", tromso).real).toBe(true);  // the midnight sun
    // Polar night: an equinox arc over the whole day, highest at the real noon (90° − 69.65° ≈ 20°).
    const winter = at("2026-12-21T10:45:00Z", tromso);
    expect(winter.real).toBe(false);
    expect(winter.elevation).toBeGreaterThan(18);
    for (let hour = 1; hour < 24; hour += 2) {
      expect(at(new Date(Date.UTC(2026, 11, 21, hour)).toISOString(), tromso).elevation).toBeGreaterThanOrEqual(0);
    }
  });
});
