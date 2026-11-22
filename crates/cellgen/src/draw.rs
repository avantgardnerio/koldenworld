//! Debug pictures: what we built, top-down in (s, t), as a PNG.

use crate::polygon::Polygon;

/// What a picture shows: `view` (s0, t0, s1, t1) fills a `size` px square; `cell` (s0, t0, s1, t1) is outlined.
#[derive(Clone, Copy)]
pub struct View {
    pub view: [f64; 4],
    pub cell: [f64; 4],
    pub size: u32,
}

/// What we built, in (s, t) on the cell's face: each set of `fills` in its color, in order, then the cell's square
/// in red, framed by `frame` (s to the right, t up). Ground no fill reaches stays white.
pub fn draw_png(
    fills: &[(Vec<&Polygon>, [u8; 3])],
    frame: &View,
    path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let View { view, cell, size } = *frame;
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

    for (polys, [r, g, b]) in fills {
        paint.set_color_rgba8(*r, *g, *b, 255);
        for poly in polys {
            if let Some(p) = path_of(&mut poly.positions().map(|p| p.to_array()), true) {
                pixmap.fill_path(&p, &paint, tiny_skia::FillRule::Winding, identity, None);
            }
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

    pixmap.save_png(path)?;
    Ok(())
}
