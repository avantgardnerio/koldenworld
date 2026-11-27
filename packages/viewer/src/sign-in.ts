// Sign-in with Google (the server's auth.rs): before the game starts, /auth/me says who's signed in. A 401 means sign-in
// is on and nobody is: a screen with the Google button, which comes back here (same place, same query). Anything else
// (a player, null for a server without sign-in, or no server at all, as in the hermetic e2e test) lets the game start;
// a player gets their name and a sign-out link in the footer.
//
// CloudFront's cookies last an hour (so a ban bites within one); /auth/me renews them, every RENEW while the game runs
// and as soon as a tab that slept longer comes back. If renewal says 401 (signed out, or banned), the page reloads to
// the sign-in screen.

/** How often the cookies are renewed: well inside their hour. */
const RENEW_MS = 20 * 60_000;

/** Whether the game may start: false while the sign-in screen is up. */
export async function signedIn(): Promise<boolean> {
  let answer: Response;
  try {
    answer = await fetch("/auth/me", { credentials: "same-origin" });
  } catch {
    return true;  // no server to ask: nothing to sign in to
  }
  if (answer.status === 401) {
    showSignIn();
    return false;
  }
  if (!answer.ok) return true;
  const player = (await answer.json().catch(() => null)) as { name?: string; email?: string } | null;
  if (player) {
    showPlayer(player.name ?? player.email ?? "signed in");
    keepRenewing();
  }
  return true;
}

function keepRenewing(): void {
  let renewed = Date.now();
  const renew = async (): Promise<void> => {
    renewed = Date.now();
    const answer = await fetch("/auth/me", { credentials: "same-origin" }).catch(() => null);
    if (answer?.status === 401) location.reload();
  };
  setInterval(() => void renew(), RENEW_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - renewed > RENEW_MS) void renew();
  });
}

function showSignIn(): void {
  const then = location.pathname + location.search + location.hash;
  const screen = document.createElement("div");
  screen.id = "sign-in";
  const title = document.createElement("h1");
  title.textContent = "koldenworld";
  const button = document.createElement("a");
  button.href = `/auth/google?then=${encodeURIComponent(then)}`;
  button.textContent = "Sign in with Google";
  screen.append(title, button);
  document.body.append(screen);
}

function showPlayer(name: string): void {
  const footer = document.querySelector("footer");
  if (!footer) return;
  const out = document.createElement("a");
  out.href = "/auth/logout";
  out.textContent = "sign out";
  footer.append(` · ${name} (`, out, ")");
}
