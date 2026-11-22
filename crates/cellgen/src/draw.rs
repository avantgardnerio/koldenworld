//! Debug pictures: what we built, top-down in (s, t), as a PNG.

use crate::graph::RoadGraph;
use crate::ways::RoadWays;

const EDGE_COLORS: [[u8; 3]; 6] = [
    [31, 119, 180],
    [255, 127, 14],
    [44, 160, 44],
    [148, 103, 189],
    [140, 86, 75],
    [23, 190, 207],
];

/// The graph in (s, t) on the cell's face: each edge in its own color (so the cuts show), nodes as dots by degree
/// (dead end red, 2 grey, 3–4 blue, 5+ magenta), and the cell's square in red. `view` (s0, t0, s1, t1) fills a
/// `size` px square, s to the right and t up.
pub fn draw_png(
    ways: &RoadWays,
    graph: &RoadGraph,
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
    let mut paint = tiny_skia::Paint {
        anti_alias: true,
        ..Default::default()
    };
    let stroke = tiny_skia::Stroke {
        width: 2.0,
        ..Default::default()
    };
    let mut draw =
        |points: &mut dyn Iterator<Item = [f64; 2]>, closed: bool, paint: &tiny_skia::Paint| {
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
            if let Some(line) = line.finish() {
                pixmap.stroke_path(
                    &line,
                    paint,
                    &stroke,
                    tiny_skia::Transform::identity(),
                    None,
                );
            }
        };

    for e in 0..graph.edge_count() {
        let [r, g, b] = EDGE_COLORS[e % EDGE_COLORS.len()];
        paint.set_color_rgba8(r, g, b, 255);
        let points = &ways.st[graph.edge_first[e] as usize..=graph.edge_last[e] as usize];
        draw(&mut points.iter().copied(), false, &paint);
    }
    paint.set_color_rgba8(220, 40, 40, 255);
    let [s0, t0, s1, t1] = cell;
    draw(
        &mut [[s0, t0], [s1, t0], [s1, t1], [s0, t1]].into_iter(),
        true,
        &paint,
    );

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
            pixmap.fill_path(
                &dot,
                &paint,
                tiny_skia::FillRule::Winding,
                tiny_skia::Transform::identity(),
                None,
            );
        }
    }

    pixmap.save_png(path)?;
    Ok(())
}
