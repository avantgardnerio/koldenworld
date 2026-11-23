// What the player carries, and the one thing in their hand. Pure.
//
// The inventory is slots, each an item (ITEMS): empty hands first, then what
// they've got (a pistol, a rifle). One is selected: in their hand. A gun has
// a magazine: each shot uses a round, at most one every `interval` s;
// reloading takes `reload` s, and an empty gun starts reloading itself on the
// next pull of the trigger.

export type ItemKind = "hands" | "pistol" | "rifle";

export interface Gun {
  magazine: number;  // rounds
  interval: number;  // s between shots, at the fastest
  reload: number;    // s
  range: number;     // m a shot carries
}

export const ITEMS: Record<ItemKind, { name: string; gun?: Gun }> = {
  hands: { name: "Hands" },
  pistol: { name: "Pistol", gun: { magazine: 12, interval: 0.15, reload: 1.2, range: 200 } },
  // An AR-15-style rifle, semi-automatic: one shot a pull.
  rifle: { name: "Rifle", gun: { magazine: 30, interval: 0.1, reload: 2.2, range: 400 } },
};

export interface Inventory {
  items: ItemKind[];
  selected: number;   // index into items: what's in their hand
  rounds: number[];   // per slot, in its magazine (0 for what isn't a gun)
  cooldown: number;   // s before the next shot can go
  reloading: number;  // s left reloading (0: not)
}

/** Empty hands, a loaded pistol and a loaded rifle, hands selected. */
export function createInventory(): Inventory {
  const items: ItemKind[] = ["hands", "pistol", "rifle"];
  return { items, selected: 0, rounds: items.map((k) => ITEMS[k].gun?.magazine ?? 0), cooldown: 0, reloading: 0 };
}

/** What's in their hand. */
export const held = (inv: Inventory): ItemKind => inv.items[inv.selected]!;

/** The gun in their hand, if it's a gun. */
export const heldGun = (inv: Inventory): Gun | undefined => ITEMS[held(inv)].gun;

/** Takes slot i in hand (if there is one); switching stops a reload. */
export function select(inv: Inventory, i: number): void {
  if (i < 0 || i >= inv.items.length || i === inv.selected) return;
  inv.selected = i;
  inv.reloading = 0;
}

export function stepInventory(inv: Inventory, dt: number): void {
  inv.cooldown = Math.max(0, inv.cooldown - dt);
  if (inv.reloading > 0) {
    inv.reloading -= dt;
    if (inv.reloading <= 0) {
      inv.reloading = 0;
      inv.rounds[inv.selected] = heldGun(inv)!.magazine;
    }
  }
}

/** Starts reloading the gun in hand, unless it's full or already reloading. */
export function reload(inv: Inventory): void {
  const gun = heldGun(inv);
  if (!gun || inv.reloading > 0 || inv.rounds[inv.selected] === gun.magazine) return;
  inv.reloading = gun.reload;
}

/** Pulls the trigger: whether a shot goes (a round used); an empty gun starts reloading instead. */
export function fire(inv: Inventory): boolean {
  const gun = heldGun(inv);
  if (!gun || inv.reloading > 0 || inv.cooldown > 0) return false;
  if (inv.rounds[inv.selected] === 0) {
    reload(inv);
    return false;
  }
  inv.rounds[inv.selected]!--;
  inv.cooldown = gun.interval;
  return true;
}
