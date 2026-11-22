mod aeroways;
mod buildings;
mod cell;
mod clip;
mod crossings;
mod draw;
mod elevation;
mod faces;
mod geodesy;
mod geom;
mod graph;
mod ground_arrow;
mod landcover;
mod markings;
mod mesh;
mod polygon;
mod s2;
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
