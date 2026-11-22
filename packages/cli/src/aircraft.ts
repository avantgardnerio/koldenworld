// Live aircraft for the viewer (decision 31): GET /aircraft?lat=&lon=&nm=
// answers with readsb-style JSON from adsb.lol (open data, ODbL; no key
// today), fetched at most once per AIRCRAFT_TTL_MS for nearby requests, so
// however many tabs ask, the source sees one request every few seconds.
// The viewer parses it (parseAircraft in @game/world).

const SOURCE = process.env.AIRCRAFT_SOURCE ?? "https://api.adsb.lol/v2/point";
const AIRCRAFT_TTL_MS = 5000;
const MAX_NM = 250;  // the source's limit

export class AircraftService {
  private cache = new Map<string, { at: number; body: Promise<string> }>();
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  /** The JSON for a circle; requests within 0.1° of each other share a fetch. */
  around(lat: number, lon: number, nm: number): Promise<string> {
    const la = Math.round(lat * 10) / 10, lo = Math.round(lon * 10) / 10, r = Math.min(MAX_NM, Math.max(1, Math.round(nm)));
    const key = `${la}/${lo}/${r}`, now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < AIRCRAFT_TTL_MS) return hit.body;
    for (const [k, v] of this.cache) if (now - v.at > 60_000) this.cache.delete(k);
    const body = fetch(`${SOURCE}/${la}/${lo}/${r}`, { headers: { "User-Agent": "game-viewer (personal project)" } }).then(async (res) => {
      if (!res.ok) throw new Error(`aircraft source: HTTP ${res.status}`);
      return res.text();
    });
    body.catch((err: unknown) => {
      this.cache.delete(key);
      this.log(`aircraft ${key}: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.cache.set(key, { at: now, body });
    return body;
  }
}
