//! Debug pictures: what we built, top-down in (s, t), as a PNG.

use crate::graph::RoadGraph;
use crate::polygon::Polygon;
use crate::ways::RoadWays;

/// The graph's faces (as polygons) in (s, t) on the cell's face: each block (counterclockwise face) filled in its own pale color,
/// outsides (clockwise faces) left white; edges in dark grey; nodes as dots by degree (dead end red, 2 grey, 3–4
/// blue, 5+ magenta); and the cell's square in red. `view` (s0, t0, s1, t1) fills a `size` px square, s to the right
/// and t up.
pub fn draw_png(
    ways: &RoadWays,
    graph: &RoadGraph,
    polygons: &[Polygon],
    view: [f64; 4],
    cell: [f64; 4],
    size: u32,
    path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut pixmap = tiny_skia::Pixmap::new(size, size).ok_or("bad image size")?;
    pixmap.fill(tiny_skia::Color::WHITE);
    let to_px = |[s, t]: [f64; 2]| {
        (
            ((s - view[0]) / (view[2] - view[0]) * size as f64) as f32,
            ((view[3] - t) / (view[3] - view[1]) * size as f64) as f32,
        )
    };
    let path_of = |points: &mut dyn Iterator<Item = [f64; 2]>, closed: bool| {
        let mut line = tiny_skia::PathBuilder::new();
        for (k, p) in points.enumerate() {
            let (x, y) = to_px(p);
            if k == 0 {
                line.move_to(x, y)
            } else {
                line.line_to(x, y)
            }
        }
        if closed {
            line.close();
        }
        line.finish()
    };
    let mut paint = tiny_skia::Paint {
        anti_alias: true,
        ..Default::default()
    };
    let stroke = tiny_skia::Stroke {
        width: 2.0,
        ..Default::default()
    };
    let identity = tiny_skia::Transform::identity();

    for (f, poly) in polygons.iter().enumerate() {
        if poly.len() < 3 || poly.signed_area() <= 0.0 {
            continue;
        }
        paint.set_color_rgba8(pale(f, 0), pale(f, 1), pale(f, 2), 255);
        if let Some(p) = path_of(&mut poly.positions(), true) {
            pixmap.fill_path(&p, &paint, tiny_skia::FillRule::Winding, identity, None);
        }
    }

    paint.set_color_rgba8(70, 70, 70, 255);
    for e in 0..graph.edge_count() {
        let points = &ways.st[graph.edge_first[e] as usize..=graph.edge_last[e] as usize];
        if let Some(p) = path_of(&mut points.iter().copied(), false) {
            pixmap.stroke_path(&p, &paint, &stroke, identity, None);
        }
    }
    paint.set_color_rgba8(220, 40, 40, 255);
    let [s0, t0, s1, t1] = cell;
    if let Some(p) = path_of(
        &mut [[s0, t0], [s1, t0], [s1, t1], [s0, t1]].into_iter(),
        true,
    ) {
        pixmap.stroke_path(&p, &paint, &stroke, identity, None);
    }

    for n in 0..graph.node_count() {
        let (color, radius) = match graph.degree(n) {
            1 => ([220, 40, 40], 3.0),
            2 => ([150, 150, 150], 2.0),
            3 | 4 => ([30, 60, 200], 3.5),
            _ => ([210, 0, 210], 6.0),
        };
        paint.set_color_rgba8(color[0], color[1], color[2], 255);
        let (x, y) = to_px(ways.st[graph.node_point[n] as usize]);
        if let Some(dot) = tiny_skia::PathBuilder::from_circle(x, y, radius) {
            pixmap.fill_path(&dot, &paint, tiny_skia::FillRule::Winding, identity, None);
        }
    }

    pixmap.save_png(path)?;
    Ok(())
}

/// A pale color channel for face f: a hash of its index, kept between 170 and 250.
fn pale(f: usize, channel: u32) -> u8 {
    let h = (f as u32 ^ (channel.wrapping_mul(0x9e37_79b9)))
        .wrapping_mul(0x85eb_ca6b)
        .rotate_left(13)
        .wrapping_mul(0xc2b2_ae35);
    170 + (h >> 24) as u8 % 81
}
