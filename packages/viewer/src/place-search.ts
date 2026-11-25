// Go to any address or place: "/" opens a search box, Enter looks the text up with Nominatim (OpenStreetMap's
// geocoder, called from the browser: a handful of lookups is within its usage policy) and moves the camera there by
// setting the URL hash, which the viewer already follows. Esc closes the box. Keys typed into it stay out of the
// viewer's own key handling (WASD, V, G…), which listens on the window.

/** Height to arrive at, m above the ellipsoid: terrain is only known in Colorado so far (ground 0 elsewhere), so high
 * enough to be above Denver (~1,600 m) and still close enough to see a city at sea level. */
const ARRIVAL_HEIGHT = 2500;
const NOMINATIM = "https://nominatim.openstreetmap.org/search";

/** Adds the search box. `heading` gives the camera's current yaw and pitch (degrees) to keep on arrival. */
export function attachPlaceSearch(canvas: HTMLCanvasElement, heading: () => [yaw: number, pitch: number]) {
  const form = document.createElement("form");
  form.id = "place-search";
  form.hidden = true;
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Go to an address or place…";
  input.autocomplete = "off";
  const note = document.createElement("span");
  form.append(input, note);
  document.body.append(form);

  const open = () => {
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    form.hidden = false;
    note.textContent = "";
    input.select();
    input.focus();
  };
  const close = () => {
    form.hidden = true;
    input.blur();
  };

  addEventListener("keydown", (e) => {
    if (e.code !== "Slash" || !form.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    open();
  });
  // Typing in the box mustn't fly the camera: stop keys before they reach the window's listeners.
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.code === "Escape") close();
  });
  input.addEventListener("keyup", (e) => e.stopPropagation());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) return;
    note.textContent = "searching…";
    try {
      const url = `${NOMINATIM}?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Nominatim answered ${response.status}`);
      const places = (await response.json()) as { lat: string; lon: string; display_name: string }[];
      const place = places[0];
      if (!place) {
        note.textContent = "not found";
        return;
      }
      const [yaw, pitch] = heading();
      location.hash = `#${Number(place.lat).toFixed(7)},${Number(place.lon).toFixed(7)},${ARRIVAL_HEIGHT},` +
        `${yaw.toFixed(1)},${pitch.toFixed(1)}`;
      note.textContent = place.display_name;
      setTimeout(close, 1500);
    } catch (err) {
      note.textContent = String(err);
    }
  });
}
