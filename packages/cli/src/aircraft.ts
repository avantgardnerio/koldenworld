// Live aircraft for the viewer (decision 31): GET /aircraft?lat=&lon=&nm=
// answers with readsb-style JSON from adsb.lol (open data, ODbL; no key
// today). The source has a daily quota (500 a day, HTTP 429 past it), so it
// sees one request per gap however many tabs ask or wherever they are: at
// least MIN_GAP_MS, widened to spread the quota it reports is left over the
// rest of its window, and nothing at all while it has asked us to back off.
// In between, a request gets the freshest answer for a nearby circle, up to
// STALE_MS (or two gaps) old; the viewer extrapolates positions anyway. The viewer parses it (parseAircraft in @game/world).

const SOURCE = process.env.AIRCRAFT_SOURCE ?? "https://api.adsb.lol/v2/point";
const AIRCRAFT_TTL_MS = 5000;     // an answer this fresh is reused as is
const MIN_GAP_MS = 5000;          // between any two requests to the source
const STALE_MS = 120_000;         // the oldest answer served while waiting or blocked
const NEAR_DEG = 0.5;             // how far away a stale answer's center may be
const BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000];  // after successive 429s without Retry-After
const MAX_NM = 250;  // the source's limit

interface Answer { at: number; lat: number; lon: number; body: string }

export class AircraftService {
  private cache = new Map<string, Answer>();
  private inflight: Promise<string> | null = null;
  private lastFetch = 0;
  private gap = MIN_GAP_MS;  // between requests to the source; wider when its quota runs low
  private blockedUntil = 0;
  private strikes = 0;
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  /** The JSON for a circle; requests within 0.1° of each other share an answer. */
  around(lat: number, lon: number, nm: number): Promise<string> {
    const la = Math.round(lat * 10) / 10, lo = Math.round(lon * 10) / 10, r = Math.min(MAX_NM, Math.max(1, Math.round(nm)));
    const key = `${la}/${lo}/${r}`, now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < AIRCRAFT_TTL_MS) return Promise.resolve(hit.body);
    const maxAge = Math.max(STALE_MS, 2 * this.gap);
    for (const [k, v] of this.cache) if (now - v.at > maxAge) this.cache.delete(k);
    if (this.inflight || now < this.blockedUntil || now - this.lastFetch < this.gap) return this.stale(la, lo);
    this.lastFetch = now;
    const body = this.fetch(key, la, lo, r);
    this.inflight = body;
    void body.finally(() => { this.inflight = null; }).catch(() => {});
    return body.catch(() => this.stale(la, lo));
  }

  private async fetch(key: string, lat: number, lon: number, r: number): Promise<string> {
    try {
      const res = await fetch(`${SOURCE}/${lat}/${lon}/${r}`, { headers: { "User-Agent": "game-viewer (personal project)" } });
      // adsb.lol's limit is a daily quota (x-ratelimit-limit: 500;w=86400): spread what is left over the window.
      const remaining = Number(res.headers.get("x-ratelimit-remaining")), reset = Number(res.headers.get("x-ratelimit-reset"));
      if (res.headers.has("x-ratelimit-reset") && Number.isFinite(remaining) && reset > 0) {
        this.gap = Math.max(MIN_GAP_MS, reset * 1000 / Math.max(1, remaining));
      }
      if (res.status === 429) {
        const retry = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retry) && retry > 0 ? retry * 1000
          : reset > 0 ? reset * 1000
          : BACKOFF_MS[Math.min(this.strikes, BACKOFF_MS.length - 1)]!;
        this.strikes++;
        this.blockedUntil = Date.now() + wait;
        throw new Error(`aircraft source: HTTP 429, backing off ${Math.round(wait / 1000)} s (until ${new Date(this.blockedUntil).toISOString()})`);
      }
      if (!res.ok) throw new Error(`aircraft source: HTTP ${res.status}`);
      const body = await res.text();
      this.strikes = 0;
      this.cache.set(key, { at: Date.now(), lat, lon, body });
      return body;
    } catch (err) {
      this.log(`aircraft ${key}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /** The freshest answer for a circle centered within NEAR_DEG, or a rejection if there is none. */
  private stale(lat: number, lon: number): Promise<string> {
    let best: Answer | undefined;
    for (const a of this.cache.values()) {
      if (Math.abs(a.lat - lat) <= NEAR_DEG && Math.abs(a.lon - lon) <= NEAR_DEG && (!best || a.at > best.at)) best = a;
    }
    if (best) return Promise.resolve(best.body);
    const wait = Math.max(this.blockedUntil, this.lastFetch + MIN_GAP_MS) - Date.now();
    return Promise.reject(new Error(`aircraft source: rate-limited, next request in ${Math.max(1, Math.ceil(wait / 1000))} s`));
  }
}
