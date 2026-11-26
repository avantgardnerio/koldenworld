//! What a lon/lat box query returns, as PostGIS answers it, for features loaded from the cell files instead of
//! Postgres: lines and polygons that intersect the box (ST_Intersects), outlines whose bounding box overlaps it (&&),
//! and rings oriented as ST_ForcePolygonCCW leaves them (outer counterclockwise, holes clockwise). Planar, in degrees,
//! as the geometry columns are.

/// Whether a line (its points in order) has a point in the box: a vertex in it, or a segment through it.
pub fn line_meets_box(points: &[[f64; 2]], bbox: [f64; 4]) -> bool {
    match points {
        [] => false,
        [p] => inside(*p, bbox),
        _ => points
            .windows(2)
            .any(|s| segment_meets_box(s[0], s[1], bbox)),
    }
}

/// Whether a polygon (its rings, outer first) has a point in the box: a ring through it, or the box inside the
/// polygon (inside the outer ring and in no hole: with no ring through the box, one corner tells).
pub fn polygon_meets_box<'a>(
    rings: impl IntoIterator<Item = &'a [[f64; 2]]> + Clone,
    bbox: [f64; 4],
) -> bool {
    if rings.clone().into_iter().any(|r| line_meets_box(r, bbox)) {
        return true;
    }
    let corner = [bbox[0], bbox[1]];
    let mut rings = rings.into_iter();
    rings.next().is_some_and(|outer| in_ring(outer, corner))
        && !rings.any(|hole| in_ring(hole, corner))
}

/// Whether the points' bounding box overlaps the box (&&, edges included).
pub fn bounds_overlap(points: &[[f64; 2]], [west, south, east, north]: [f64; 4]) -> bool {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for &[x, y] in points {
        (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
    }
    x0 <= east && x1 >= west && y0 <= north && y1 >= south
}

/// A ring's points into `out`, counterclockwise or clockwise as asked (reversed if it isn't).
pub fn push_ring(ring: &[[f64; 2]], counterclockwise: bool, out: &mut Vec<[f64; 2]>) {
    if (signed_area(ring) > 0.0) == counterclockwise {
        out.extend_from_slice(ring);
    } else {
        out.extend(ring.iter().rev());
    }
}

/// Whether the segment a–b has a point in the box (Liang–Barsky: clip its parameter range by each side).
pub fn segment_meets_box(a: [f64; 2], b: [f64; 2], [west, south, east, north]: [f64; 4]) -> bool {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for (p, q) in [
        (-dx, a[0] - west),
        (dx, east - a[0]),
        (-dy, a[1] - south),
        (dy, north - a[1]),
    ] {
        if p == 0.0 {
            if q < 0.0 {
                return false; // parallel to this side and outside it
            }
        } else {
            let t = q / p;
            if p < 0.0 {
                t0 = t0.max(t);
            } else {
                t1 = t1.min(t);
            }
        }
    }
    t0 <= t1
}

fn inside([x, y]: [f64; 2], [west, south, east, north]: [f64; 4]) -> bool {
    x >= west && x <= east && y >= south && y <= north
}

/// Twice the ring's signed area: positive when counterclockwise.
fn signed_area(ring: &[[f64; 2]]) -> f64 {
    ring.windows(2)
        .map(|s| s[0][0] * s[1][1] - s[1][0] * s[0][1])
        .sum()
}

/// Whether a point is inside a closed ring (even-odd crossings of a ray east).
fn in_ring(ring: &[[f64; 2]], [x, y]: [f64; 2]) -> bool {
    let mut inside = false;
    for s in ring.windows(2) {
        let ([x0, y0], [x1, y1]) = (s[0], s[1]);
        if (y0 > y) != (y1 > y) && x < x0 + (y - y0) / (y1 - y0) * (x1 - x0) {
            inside = !inside;
        }
    }
    inside
}
