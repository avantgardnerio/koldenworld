mod aeroways;
mod areas;
mod boxes;
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
mod import;
mod landcover;
mod local;
mod markings;
mod mesh;
mod osm;
mod polygon;
mod s2;
mod s3;
mod serve;
mod simplify;
mod terrain;
mod water;
mod ways;
mod widths;

use std::path::PathBuf;

const USAGE: &str = "usage:
  cellgen cell <token | lat,lon>... [--pictures] [--ways <file.json> [--height <m>]] [--out <dir>]
               [--min-class <class>] [--simplify <m>] [--terrain <n>] [--no-markings] [--no-sidewalks]
      build cells (at any level; level 10 and coarser draw less, as cell::Options::for_level; the flags override it):
      <out>/<token>/ (default out: data/rust-cells), pictures in target/. With --ways, from those ways
      (JSON, as the TS RoadWayInput) instead of the database: no water, terrain flat at --height (default 0)
  cellgen buildings <token> [--gap <m>] [--simplify <m>] [--outline <m>]
                                                a tile's buildings merged into massing: target/buildings.png
  cellgen fetch <token | lat,lon>               an area's raw OSM (Overpass, cached in data/osm/s2/), parsed: counts
  cellgen extract <token | lat,lon>             an area's roads, buildings, water, airports, points of interest: counts
  cellgen import <token | lat,lon>              an area's OSM (fetched if need be) into Postgres: rows upserted, deleted
  cellgen region <lat,lon> [--download]          the Geofabrik region holding a point (its extract, downloaded once)
  cellgen compare <token | lat,lon>             a cell's inputs from Postgres and from the cell files: what differs
  cellgen serve [--port <port>]                 cell server on 127.0.0.1 (default port 5175)

The database is CELLGEN_DB (default: the local socket, as the game role); the data directory (dem/ and the cache)
is GAME_DATA (default: the repo's data/, found from here up).";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().position(|a| a == name);
    let db = std::env::var("CELLGEN_DB")
        .unwrap_or_else(|_| "host=/var/run/postgresql user=game dbname=game".into());
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
            let (pool, data) = match fixture {
                Some(_) => (None, None),
                None => (Some(pool(&db)?), Some(data_dir()?)),
            };
            let runtime = tokio::runtime::Runtime::new()?;
            let out = match value("--out")? {
                Some(o) => PathBuf::from(o),
                None => data.clone().unwrap_or(data_dir()?).join("rust-cells"),
            };
            for c in &cells {
                let started = std::time::Instant::now();
                let inputs = match (&fixture, &pool, data.as_deref()) {
                    (Some(ways), _, _) => cell::Inputs::fixture(ways, height, c),
                    (None, Some(pool), Some(data)) => runtime
                        .block_on(cell::Inputs::load(pool, data, c, &options(c)))
                        .map_err(|e| e.to_string())?,
                    _ => unreachable!(),
                };
                let loaded = started.elapsed();
                let built = cell::build(inputs, c, &options(c), pictures.as_deref())?;
                let dir = out.join(&c.token);
                std::fs::create_dir_all(&dir)?;
                std::fs::write(dir.join("ground.arrow"), &built.ground)?;
                std::fs::write(dir.join("ground_triangles.arrow"), &built.triangles)?;
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
            let pool = pool(&db)?;
            let box_ = s2::lat_lon_bounds(c.face, c.square, 0.0);
            let b = tokio::runtime::Runtime::new()?
                .block_on(async {
                    let db = pool.get().await?;
                    buildings::load(&db, box_, |lon, lat| c.owns(lon, lat)).await
                })
                .map_err(|e| e.to_string())?;
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
        Some("import") => {
            let what = args.get(1).ok_or(USAGE)?;
            let c = match what.split_once(',') {
                Some((lat, lon)) => fetch::fetch_cell(lat.trim().parse()?, lon.trim().parse()?),
                None => cell::Cell::from_token(what).ok_or(format!("{what} isn't a cell token"))?,
            };
            let data = data_dir()?;
            let pool = pool(&db)?;
            let started = std::time::Instant::now();
            let counts = tokio::runtime::Runtime::new()?
                .block_on(async {
                    // --local: from the cell files under data/osm/cells (local.rs), not Overpass.
                    let (raw, source, osm) = if args.get(2).map(String::as_str) == Some("--local") {
                        let cells = local::cells_dir(&data);
                        let loaded = local::load(&cells, &c)?.ok_or(format!(
                            "no cell files for {} under {}",
                            c.token,
                            cells.display()
                        ))?;
                        (loaded.identity, loaded.source, loaded.osm)
                    } else {
                        let raw = fetch::fetch(&data, &c, |m| println!("{m}")).await?;
                        let osm = osm::parse(&raw)?;
                        (raw, fetch::OVERPASS_URL.to_string(), osm)
                    };
                    let x = extract::extract(&osm);
                    let area = format!("s2:{}", c.token);
                    let snapshot = import::Snapshot {
                        area: &area,
                        bbox: fetch::padded_box(&c),
                        source: &source,
                        raw: &raw,
                    };
                    let mut db = pool.get().await?;
                    import::import(&mut db, &snapshot, &osm, &x).await
                })
                .map_err(|e| e.to_string())?;
            println!("{} imported in {:.1?}", c.token, started.elapsed());
            println!("  upserted: {:?}", counts.upserted);
            println!("  deleted:  {:?}", counts.deleted);
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
        Some("compare") => {
            // A cell's road ways from Postgres and from the cell files: what differs.
            let what = args.get(1).ok_or(USAGE)?;
            let c = match what.split_once(',') {
                Some((lat, lon)) => cell::Cell::at(lat.trim().parse()?, lon.trim().parse()?),
                None => cell::Cell::from_token(what).ok_or(format!("{what} isn't a cell token"))?,
            };
            println!("cell {} (level {})", c.token, c.level);
            let bbox = c.load_box();
            let started = std::time::Instant::now();
            let osm = local::load_box(&local::cells_dir(&data_dir()?), bbox)
                .map_err(|e| e.to_string())?
                .ok_or("no cell files for that box")?;
            let x = extract::extract(&osm);
            let files = ways::RoadWays::from_extracted(&osm, &x, bbox);
            println!(
                "files: {} ways ({} OSM ways loaded) in {:.1?}",
                files.osm_id.len(),
                osm.ways(),
                started.elapsed()
            );
            let [west, south, east, north] = bbox;
            let pool = pool(&db)?;
            let owns = |lon, lat| c.owns(lon, lat);
            let (db, water, aeroways, buildings) = tokio::runtime::Runtime::new()?
                .block_on(async {
                    let client = pool.get().await?;
                    Ok::<_, Box<dyn std::error::Error + Send + Sync>>((
                        ways::load_road_ways(&client, west, south, east, north).await?,
                        water::load_water(&client, west, south, east, north, 0.0).await?,
                        aeroways::load(&client, bbox).await?,
                        buildings::load(&client, bbox, owns).await?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            println!("postgres: {} ways", db.osm_id.len());
            compare_ways(&db, &files);
            let w = water::Water::from_extracted(&osm, &x, bbox, 0.0);
            let same = |what: &str, n: (usize, usize), equal: bool| {
                println!(
                    "{what}: postgres {}, files {}{}",
                    n.0,
                    n.1,
                    if equal { ", identical" } else { ", DIFFER" }
                );
            };
            same(
                "waterways",
                (water.width.len(), w.width.len()),
                water.width == w.width
                    && water.line_start == w.line_start
                    && water.lonlat[..water.ring_start[0] as usize]
                        == w.lonlat[..w.ring_start[0] as usize],
            );
            same(
                "water rings",
                (water.ring_start.len() - 1, w.ring_start.len() - 1),
                water.lonlat == w.lonlat && water.ring_start == w.ring_start,
            );
            let a = aeroways::Aeroways::from_extracted(&osm, &x, bbox);
            same(
                "airport lines",
                (aeroways.line_kind.len(), a.line_kind.len()),
                aeroways.line_kind == a.line_kind
                    && aeroways.width == a.width
                    && aeroways.line_start == a.line_start,
            );
            same(
                "airport rings",
                (aeroways.ring_kind.len(), a.ring_kind.len()),
                aeroways.ring_kind == a.ring_kind
                    && aeroways.ring_start == a.ring_start
                    && aeroways.lonlat == a.lonlat,
            );
            let b = buildings::from_extracted(&osm, &x, bbox, owns);
            same(
                "buildings",
                (buildings.osm_id.len(), b.osm_id.len()),
                buildings.osm_id == b.osm_id
                    && buildings.height == b.height
                    && buildings.ring_of == b.ring_of
                    && buildings.ring_start == b.ring_start
                    && buildings.lonlat == b.lonlat,
            );
            if buildings.osm_id != b.osm_id {
                let (pa, pb): (
                    std::collections::HashSet<i64>,
                    std::collections::HashSet<i64>,
                ) = (
                    buildings.osm_id.iter().copied().collect(),
                    b.osm_id.iter().copied().collect(),
                );
                let mut only_a: Vec<_> = pa.difference(&pb).copied().collect();
                let mut only_b: Vec<_> = pb.difference(&pa).copied().collect();
                only_a.sort_unstable();
                only_b.sort_unstable();
                println!(
                    "  buildings only in postgres: {} {:?}",
                    only_a.len(),
                    &only_a[..only_a.len().min(8)]
                );
                println!(
                    "  buildings only in files:    {} {:?}",
                    only_b.len(),
                    &only_b[..only_b.len().min(8)]
                );
            }
            Ok(())
        }
        Some("serve") => {
            let port = match flag("--port") {
                Some(i) => args.get(i + 1).ok_or(USAGE)?.parse()?,
                None => 5175,
            };
            serve::serve(port, data_dir()?, pool(&db)?)
        }
        _ => Err(USAGE.into()),
    }
}

/// A pool of Postgres connections from a connection string (as libpq's: "host=… user=… dbname=…").
/// What differs between two sets of road ways (`a` Postgres's, `b` the files'), way by way, the first few of each kind.
fn compare_ways(a: &ways::RoadWays, b: &ways::RoadWays) {
    use std::collections::HashMap;
    let index = |w: &ways::RoadWays| -> HashMap<i64, usize> {
        w.osm_id
            .iter()
            .enumerate()
            .map(|(i, &id)| (id, i))
            .collect()
    };
    let (ia, ib) = (index(a), index(b));
    let only = |x: &HashMap<i64, usize>, y: &HashMap<i64, usize>| {
        let mut ids: Vec<i64> = x.keys().filter(|id| !y.contains_key(id)).copied().collect();
        ids.sort_unstable();
        ids
    };
    let (only_a, only_b) = (only(&ia, &ib), only(&ib, &ia));
    println!(
        "only in postgres: {} {:?}",
        only_a.len(),
        &only_a[..only_a.len().min(8)]
    );
    println!(
        "only in files:    {} {:?}",
        only_b.len(),
        &only_b[..only_b.len().min(8)]
    );
    let mut differ: HashMap<&str, Vec<i64>> = HashMap::new();
    for (&id, &i) in &ia {
        let Some(&j) = ib.get(&id) else { continue };
        let nodes =
            |w: &ways::RoadWays, k: usize| w.node_start[k] as usize..w.node_start[k + 1] as usize;
        let checks = [
            ("class", a.class[i] == b.class[j]),
            (
                "name",
                a.names[a.name[i] as usize] == b.names[b.name[j] as usize],
            ),
            ("nodes", a.node_id[nodes(a, i)] == b.node_id[nodes(b, j)]),
            (
                "coordinates",
                a.lonlat[nodes(a, i)] == b.lonlat[nodes(b, j)],
            ),
            (
                "lanes",
                (a.lanes_fwd[i], a.lanes_back[i]) == (b.lanes_fwd[j], b.lanes_back[j]),
            ),
            ("sidewalks", a.sidewalks[i] == b.sidewalks[j]),
        ];
        for (what, same) in checks {
            if !same {
                differ.entry(what).or_default().push(id);
            }
        }
    }
    let mut kinds: Vec<_> = differ.into_iter().collect();
    kinds.sort();
    for (what, mut ids) in kinds {
        ids.sort_unstable();
        println!(
            "{what} differs: {} {:?}",
            ids.len(),
            &ids[..ids.len().min(8)]
        );
    }
}

fn pool(db: &str) -> Result<deadpool_postgres::Pool, Box<dyn std::error::Error>> {
    let config: tokio_postgres::Config = db.parse()?;
    let manager = deadpool_postgres::Manager::from_config(
        config,
        tokio_postgres::NoTls,
        deadpool_postgres::ManagerConfig {
            recycling_method: deadpool_postgres::RecyclingMethod::Fast,
        },
    );
    Ok(deadpool_postgres::Pool::builder(manager)
        .max_size(32)
        .build()?)
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
