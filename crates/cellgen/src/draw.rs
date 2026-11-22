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

    // Each set as one path, filled nonzero: a clockwise ring inside a counterclockwise one is a hole.
    for (polys, [r, g, b]) in fills {
        paint.set_color_rgba8(*r, *g, *b, 255);
        let mut all = tiny_skia::PathBuilder::new();
        for poly in polys {
            if let Some(p) = path_of(&mut poly.positions().map(|p| p.to_array()), true) {
                all.push_path(&p);
            }
        }
        if let Some(p) = all.finish() {
            pixmap.fill_path(&p, &paint, tiny_skia::FillRule::Winding, identity, None);
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

/// A height grid ((n + 1)², rows from t = 0 up) as a shaded relief: grey by height, lit from the northwest. `spacing`
/// is the grid's spacing in metres (for the slopes).
pub fn draw_heights(
    heights: &[f64],
    n: usize,
    spacing: f64,
    path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let side = n + 1;
    let (lo, hi) = heights
        .iter()
        .fold((f64::MAX, f64::MIN), |(lo, hi), &h| (lo.min(h), hi.max(h)));
    let scale = 8; // pixels per sample
    let mut pixmap = tiny_skia::Pixmap::new((side * scale) as u32, (side * scale) as u32)
        .ok_or("bad image size")?;
    let at = |a: usize, b: usize| heights[b.min(n) * side + a.min(n)];
    for b in 0..side {
        for a in 0..side {
            let (dzs, dzt) = (
                (at(a + 1, b) - at(a.saturating_sub(1), b)) / (2.0 * spacing),
                (at(a, b + 1) - at(a, b.saturating_sub(1))) / (2.0 * spacing),
            );
            let shade = (0.5 + 2.0 * (-dzs + dzt)).clamp(0.0, 1.0);
            let grey = (at(a, b) - lo) / (hi - lo).max(1e-9);
            let v = (40.0 + 150.0 * grey + 65.0 * shade) as u8;
            let paint = tiny_skia::Paint {
                shader: tiny_skia::Shader::SolidColor(tiny_skia::Color::from_rgba8(v, v, v, 255)),
                ..Default::default()
            };
            let rect = tiny_skia::Rect::from_xywh(
                (a * scale) as f32,
                ((n - b) * scale) as f32,
                scale as f32,
                scale as f32,
            )
            .ok_or("rect")?;
            pixmap.fill_rect(rect, &paint, tiny_skia::Transform::identity(), None);
        }
    }
    pixmap.save_png(path)?;
    Ok(())
}

/// Draped ground: each piece in its kind's color, shaded by its terrain triangle (`light`, 0..1); the pieces of one
/// kind in one triangle filled together (nonzero), so holes show.
pub fn draw_draped(
    d: &crate::terrain::Draped,
    colors: &[[u8; 3]],
    light: impl Fn(u32) -> f64,
    frame: &View,
    path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let View { view, size, .. } = *frame;
    let mut pixmap = tiny_skia::Pixmap::new(size, size).ok_or("bad image size")?;
    pixmap.fill(tiny_skia::Color::WHITE);
    let to_px = |p: glam::DVec2| {
        (
            ((p.x - view[0]) / (view[2] - view[0]) * size as f64) as f32,
            ((view[3] - p.y) / (view[3] - view[1]) * size as f64) as f32,
        )
    };
    let mut p = 0;
    while p < d.kind.len() {
        let (kind, tri) = (d.kind[p], d.tri[p]);
        let mut all = tiny_skia::PathBuilder::new();
        while p < d.kind.len() && d.kind[p] == kind && d.tri[p] == tri {
            for (k, &q) in d.st[d.start[p] as usize..d.start[p + 1] as usize]
                .iter()
                .enumerate()
            {
                let (x, y) = to_px(q);
                if k == 0 {
                    all.move_to(x, y)
                } else {
                    all.line_to(x, y)
                }
            }
            all.close();
            p += 1;
        }
        let shade = 0.55 + 0.6 * light(tri);
        let [r, g, b] = colors[kind as usize].map(|c| (c as f64 * shade).min(255.0) as u8);
        let paint = tiny_skia::Paint {
            shader: tiny_skia::Shader::SolidColor(tiny_skia::Color::from_rgba8(r, g, b, 255)),
            anti_alias: false,
            ..Default::default()
        };
        if let Some(path) = all.finish() {
            pixmap.fill_path(
                &path,
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

/// GPU buffers drawn top-down from nothing but the buffers: x east to the right, y north up, every triangle in its
/// material's color, shaded by its normal (light from the northwest, high).
pub fn draw_mesh(
    m: &crate::mesh::Mesh,
    colors: &[[u8; 3]],
    size: u32,
    path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let (mut lo, mut hi) = ([f32::MAX; 2], [f32::MIN; 2]);
    for p in &m.positions {
        for k in 0..2 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let span = (hi[0] - lo[0]).max(hi[1] - lo[1]);
    let to_px = |p: [f32; 3]| {
        (
            (p[0] - lo[0]) / span * size as f32,
            (hi[1] - p[1]) / span * size as f32,
        )
    };
    let light = glam::Vec3::new(-1.0, 1.0, 2.0).normalize();
    let mut pixmap = tiny_skia::Pixmap::new(size, size).ok_or("bad image size")?;
    pixmap.fill(tiny_skia::Color::WHITE);
    for t in m.indices.chunks(3) {
        let [a, b, c] = [t[0], t[1], t[2]].map(|i| i as usize);
        let shade = 0.35
            + 0.75
                * (glam::Vec3::new(
                    m.normals[a][0] as f32,
                    m.normals[a][1] as f32,
                    m.normals[a][2] as f32,
                ) / 127.0)
                    .dot(light)
                    .max(0.0);
        let [r, g, bl] =
            colors[m.material[a] as usize].map(|c| (c as f32 * shade).min(255.0) as u8);
        let mut tri = tiny_skia::PathBuilder::new();
        let ((x0, y0), (x1, y1), (x2, y2)) = (
            to_px(m.positions[a]),
            to_px(m.positions[b]),
            to_px(m.positions[c]),
        );
        tri.move_to(x0, y0);
        tri.line_to(x1, y1);
        tri.line_to(x2, y2);
        tri.close();
        let paint = tiny_skia::Paint {
            shader: tiny_skia::Shader::SolidColor(tiny_skia::Color::from_rgba8(r, g, bl, 255)),
            anti_alias: false,
            ..Default::default()
        };
        if let Some(tri) = tri.finish() {
            pixmap.fill_path(
                &tri,
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
