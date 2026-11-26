mod aeroways;
mod aircraft;
mod boxes;
mod building_inputs;
mod building_table;
mod buildings;
mod cell;
mod clip;
mod crossings;
mod draw;
mod elevation;
mod extract;
mod faces;
mod fetch;
mod geodesy;
mod geofabrik;
mod geom;
mod graph;
mod ground_arrow;
mod landcover;
mod local;
mod markings;
mod mesh;
mod osm;
mod poi_table;
mod pois;
mod polygon;
mod road_table;
mod s2;
mod s3;
mod serve;
mod simplify;
mod terrain;
mod terrain_arrow;
mod water;
mod ways;
mod widths;

use std::path::PathBuf;

const USAGE: &str = "usage:
  cellgen cell <token | lat,lon>... [--pictures] [--ways <file.json> [--height <m>]] [--out <dir>]
               [--min-class <class>] [--simplify <m>] [--terrain <n>] [--no-markings] [--no-sidewalks]
      build cells (at any level; level 10 and coarser draw less, as cell::Options::for_level; the flags override it):
      <out>/<token>/ (default out: data/rust-cells), pictures in target/. With --ways, from those ways
      (JSON, as the TS RoadWayInput) instead of the cell files: no water, terrain flat at --height (default 0)
  cellgen buildings <token> [--gap <m>] [--simplify <m>] [--outline <m>]
                                                a tile's buildings merged into massing: target/buildings.png
  cellgen fetch <token | lat,lon>               an area's raw OSM (Overpass, cached in data/osm/s2/), parsed: counts
  cellgen extract <token | lat,lon>             an area's roads, buildings, water, airports, points of interest: counts
  cellgen region <lat,lon> [--download]          the Geofabrik region holding a point (its extract, downloaded once)
  cellgen serve [--port <port>]                 cell server and live air traffic on 127.0.0.1 (default port 5175)

The data directory (dem/, the cell files and the caches) is GAME_DATA (default: the repo's data/, found from here
up).";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().position(|a| a == name);
    match args.first().map(String::as_str) {
        Some("cell") => {
            let value = |name: &str| flag(name).map(|i| args.get(i + 1).ok_or(USAGE)).transpose();
            let cells = args[1..]
                .iter()
                .take_while(|a| !a.starts_with("--"))
                .map(|what| match what.split_once(',') {
                    Some((lat, lon)) => {
                        Ok(cell::Cell::at(lat.trim().parse()?, lon.trim().parse()?))
                    }
                    None => cell::Cell::from_token(what)
                        .ok_or_else(|| format!("{what} isn't a cell token").into()),
                })
                .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
            if cells.is_empty() {
                return Err(USAGE.into());
            }
            let pictures = flag("--pictures").map(|_| PathBuf::from("target"));
            let fixture = value("--ways")?
                .map(|f| ways::from_json(&std::fs::read_to_string(f)?))
                .transpose()?;
            let height: f64 = value("--height")?.map_or(Ok(0.0), |h| h.parse())?;
            // Each cell's level decides what it draws (Options::for_level); these flags override it.
            let min_class = value("--min-class")?
                .map(|c| {
                    ways::ROAD_CLASSES
                        .iter()
                        .position(|k| k == c)
                        .map(|i| i as u8)
                        .ok_or_else(|| format!("unknown road class {c}"))
                })
                .transpose()?;
            let simplify: Option<f64> = value("--simplify")?.map(|m| m.parse()).transpose()?;
            let terrain: Option<usize> = value("--terrain")?.map(|n| n.parse()).transpose()?;
            let options = |c: &cell::Cell| {
                let mut o = cell::Options::for_level(c.level);
                o.min_class = min_class.or(o.min_class);
                o.simplify = simplify.unwrap_or(o.simplify);
                o.terrain = terrain.unwrap_or(o.terrain);
                o.markings &= flag("--no-markings").is_none();
                o.sidewalks &= flag("--no-sidewalks").is_none();
                o
            };
            let data = match fixture {
                Some(_) => None,
                None => Some(data_dir()?),
            };
            let out = match value("--out")? {
                Some(o) => PathBuf::from(o),
                None => data.clone().unwrap_or(data_dir()?).join("rust-cells"),
            };
            for c in &cells {
                let started = std::time::Instant::now();
                let inputs = match (&fixture, data.as_deref()) {
                    (Some(ways), _) => cell::Inputs::fixture(ways, height, c),
                    (None, Some(data)) => {
                        cell::Inputs::from_files(data, c, &options(c)).map_err(|e| e.to_string())?
                    }
                    _ => unreachable!(),
                };
                let loaded = started.elapsed();
                let built = cell::build(inputs, c, &options(c), pictures.as_deref())?;
                let dir = out.join(&c.token);
                std::fs::create_dir_all(&dir)?;
                std::fs::write(dir.join("ground.arrow"), &built.ground)?;
                std::fs::write(dir.join("ground_triangles.arrow"), &built.triangles)?;
                std::fs::write(dir.join("terrain.arrow"), &built.terrain)?;
                if let Some(b) = &built.fine_buildings {
                    std::fs::write(dir.join("buildings.arrow"), b)?;
                }
                if let Some(p) = &built.fine_pois {
                    std::fs::write(dir.join("pois.arrow"), p)?;
                }
                if let Some((nodes, edges)) = &built.fine_graph {
                    std::fs::write(dir.join("nodes.arrow"), nodes)?;
                    std::fs::write(dir.join("edges.arrow"), edges)?;
                }
                if let Some((v, t)) = &built.buildings {
                    std::fs::write(dir.join("buildings.arrow"), v)?;
                    std::fs::write(dir.join("buildings_triangles.arrow"), t)?;
                }
                println!(
                    "cell {} built in {:.0?} (loaded in {loaded:.0?})",
                    c.token,
                    started.elapsed()
                );
                for line in &built.log {
                    println!("  {line}");
                }
                println!("wrote {}", dir.display());
            }
            Ok(())
        }
        Some("buildings") => {
            let what = args.get(1).ok_or(USAGE)?;
            let c = cell::Cell::from_token(what).ok_or(format!("{what} isn't a cell token"))?;
            let started = std::time::Instant::now();
            let box_ = s2::lat_lon_bounds(c.face, c.square, 0.0);
            let osm = local::load_box(&local::cells_dir(&data_dir()?), box_)
                .map_err(|e| e.to_string())?
                .ok_or("no cell files for that tile")?;
            let b = buildings::from_extracted(&osm, &extract::extract(&osm), box_, |lon, lat| {
                c.owns(lon, lat)
            });
            let loaded = started.elapsed();
            let metric = s2::cell_metric(c.face, c.square);
            let gap: f64 = flag("--gap")
                .and_then(|i| args.get(i + 1))
                .map_or(Ok(buildings::GAP), |g| g.parse())?;
            let tolerance: f64 = flag("--simplify")
                .and_then(|i| args.get(i + 1))
                .map_or(Ok(buildings::SIMPLIFY), |g| g.parse())?;
            let b = simplify::simplify_buildings(&b, c.face, &metric, tolerance);
            let outline: f64 = flag("--outline")
                .and_then(|i| args.get(i + 1))
                .map_or(Ok(buildings::OUTLINE), |g| g.parse())?;
            let m = buildings::massing(&b, c.face, &metric, gap, outline);
            let towers = m.tower.iter().filter(|t| t.is_some()).count();
            let vertices =
                |paths: &[&clipper2_rust::Path64]| paths.iter().map(|p| p.len()).sum::<usize>();
            let low: Vec<_> = m
                .paths
                .iter()
                .zip(&m.tower)
                .filter(|(_, t)| t.is_none())
                .map(|(p, _)| p)
                .collect();
            let outers = low.iter().filter(|p| clipper2_rust::area(p) > 0.0).count();
            println!(
                "{} buildings ({} footprint points) loaded in {loaded:.0?}; massing in {:.0?}: {outers} shapes \
                 ({} rings, {} points) and {towers} tower rings",
                b.osm_id.len(),
                b.lonlat.len(),
                started.elapsed() - loaded,
                low.len(),
                vertices(&low),
            );
            draw::draw_massing(&m, &c, &metric, "target/buildings.png")?;
            println!("wrote target/buildings.png");
            Ok(())
        }
        Some("fetch") => {
            let what = args.get(1).ok_or(USAGE)?;
            let c = match what.split_once(',') {
                Some((lat, lon)) => fetch::fetch_cell(lat.trim().parse()?, lon.trim().parse()?),
                None => cell::Cell::from_token(what).ok_or(format!("{what} isn't a cell token"))?,
            };
            let data = data_dir()?;
            let started = std::time::Instant::now();
            let body = tokio::runtime::Runtime::new()?
                .block_on(fetch::fetch(&data, &c, |m| println!("{m}")))
                .map_err(|e| e.to_string())?;
            let got = started.elapsed();
            let started = std::time::Instant::now();
            let osm = osm::parse(&body)?;
            println!(
                "{}: {:.1} MB in {got:.1?}, parsed in {:.0?}: {} nodes ({} tagged), {} ways, {} relations, {} strings; data as of {}",
                c.token,
                body.len() as f64 / 1e6,
                started.elapsed(),
                osm.nodes(),
                (0..osm.nodes())
                    .filter(|&n| osm.node_tags.count(n) > 0)
                    .count(),
                osm.ways(),
                osm.relations(),
                osm.strings.text.len(),
                osm.timestamp.as_deref().unwrap_or("?")
            );
            Ok(())
        }
        Some("extract") => {
            let what = args.get(1).ok_or(USAGE)?;
            let c = match what.split_once(',') {
                Some((lat, lon)) => fetch::fetch_cell(lat.trim().parse()?, lon.trim().parse()?),
                None => cell::Cell::from_token(what).ok_or(format!("{what} isn't a cell token"))?,
            };
            let osm = if args.get(2).map(String::as_str) == Some("--local") {
                let cells = local::cells_dir(&data_dir()?);
                let loaded = local::load(&cells, &c)
                    .map_err(|e| e.to_string())?
                    .ok_or(format!(
                        "no cell files for {} under {}",
                        c.token,
                        cells.display()
                    ))?;
                println!(
                    "{}: {} nodes, {} ways from {}",
                    c.token,
                    loaded.osm.nodes(),
                    loaded.osm.ways(),
                    loaded.source
                );
                loaded.osm
            } else {
                let body = tokio::runtime::Runtime::new()?
                    .block_on(fetch::fetch(&data_dir()?, &c, |m| println!("{m}")))
                    .map_err(|e| e.to_string())?;
                let osm = osm::parse(&body)?;
                println!(
                    "{}: {} nodes, {} ways, {} relations from Overpass",
                    c.token,
                    osm.nodes(),
                    osm.ways(),
                    osm.relations()
                );
                osm
            };
            let started = std::time::Instant::now();
            let x = extract::extract(&osm);
            let parts = x.buildings.is_part.iter().filter(|&&p| p).count();
            let polygons = |p: &extract::Polygons| p.ring_start.len() - 1;
            println!(
                "{} extracted in {:.0?}: {} roads, {} buildings + {} parts ({} polygons), {} water areas, {} waterways, \
                 {} airport areas, {} airport lines, {} points of interest; {} skipped",
                c.token,
                started.elapsed(),
                x.roads.way.len(),
                x.buildings.is_part.len() - parts,
                parts,
                polygons(&x.buildings.shape),
                x.water_areas.kind.len(),
                x.waterways.way.len(),
                x.aeroway_areas.kind.len(),
                x.aeroway_lines.way.len(),
                x.pois.key.len(),
                x.skipped
            );
            // Sums to compare with the TS extractors.
            let r = &x.roads;
            println!(
                "  roads: lanes {}, oneway {}, sidewalk bits {}, points {}, speed {:.1}; buildings: height {:.1}, min {:.1}, \
                 levels {}, points {}; waterways: width {:.1}, points {}; airport lines: width {:.1}",
                r.lanes_fwd
                    .iter()
                    .chain(&r.lanes_back)
                    .map(|&l| l as u32)
                    .sum::<u32>(),
                r.oneway.iter().filter(|&&o| o).count(),
                r.sidewalks.iter().map(|&s| s.count_ones()).sum::<u32>(),
                r.node_id.len(),
                r.speed.iter().map(|&s| s as f64).sum::<f64>(),
                x.buildings.height.iter().map(|&h| h as f64).sum::<f64>(),
                x.buildings
                    .min_height
                    .iter()
                    .map(|&h| h as f64)
                    .sum::<f64>(),
                x.buildings.levels.iter().filter(|l| !l.is_nan()).count(),
                x.buildings.shape.lonlat.len(),
                x.waterways.width.iter().map(|&w| w as f64).sum::<f64>(),
                x.waterways.lonlat.len(),
                x.aeroway_lines.width.iter().map(|&w| w as f64).sum::<f64>(),
            );
            // A few points of interest, every 50th: kind and name.
            let name = osm.strings.find("name");
            let sample: Vec<String> = (0..x.pois.key.len())
                .step_by(50)
                .take(12)
                .map(|i| {
                    let tags = match x.pois.element_type[i] {
                        osm::NODE => &osm.node_tags,
                        osm::WAY => &osm.way_tags,
                        _ => &osm.relation_tags,
                    };
                    let n = name.and_then(|k| tags.get(x.pois.element[i] as usize, k));
                    format!(
                        "{}={} \"{}\"",
                        extract::POI_KEYS[x.pois.key[i] as usize],
                        osm.strings.text[x.pois.value[i] as usize],
                        n.map_or("", |v| osm.strings.text[v as usize].as_str())
                    )
                })
                .collect();
            println!("  points of interest, e.g.: {}", sample.join(", "));
            Ok(())
        }
        Some("region") => {
            let (lat, lon) = args.get(1).and_then(|a| a.split_once(',')).ok_or(USAGE)?;
            let (lat, lon): (f64, f64) = (lat.trim().parse()?, lon.trim().parse()?);
            let data = data_dir()?;
            let download = flag("--download").is_some();
            tokio::runtime::Runtime::new()?
                .block_on(async {
                    let index = geofabrik::index(&data).await?;
                    let Some(r) = index.region(lat, lon) else {
                        println!("no Geofabrik region holds {lat},{lon}");
                        return Ok(());
                    };
                    let mut chain = vec![index.id[r].clone()];
                    let mut p = index.parent[r];
                    while let Some(q) = p {
                        chain.push(index.id[q].clone());
                        p = index.parent[q];
                    }
                    println!("{lat},{lon}: {} ({})", chain.join(" < "), index.pbf[r]);
                    if download {
                        let path = geofabrik::pbf(&data, &index, r, |m| println!("{m}")).await?;
                        let size = tokio::fs::metadata(&path).await?.len();
                        println!("{} ({} MB)", path.display(), size / 1_000_000);
                    }
                    Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
                })
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        Some("serve") => {
            let port = match flag("--port") {
                Some(i) => args.get(i + 1).ok_or(USAGE)?.parse()?,
                None => 5175,
            };
            serve::serve(port, data_dir()?)
        }
        _ => Err(USAGE.into()),
    }
}

/// GAME_DATA, or the nearest data/ with a dem/ in it, from the working directory up.
fn data_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Ok(dir) = std::env::var("GAME_DATA") {
        return Ok(dir.into());
    }
    let here = std::env::current_dir()?;
    here.ancestors()
        .map(|d| d.join("data"))
        .find(|d| d.join("dem").is_dir())
        .ok_or_else(|| "no data/dem found from here up; set GAME_DATA".into())
}
