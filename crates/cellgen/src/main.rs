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
      build cells: <out>/<token>/ (default out: data/rust-cells), pictures in target/. With --ways, from those ways
      (JSON, as the TS RoadWayInput) instead of the database: no water, terrain flat at --height (default 0)
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
                        .ok_or_else(|| format!("{what} isn't a level-13 cell").into()),
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
            let options = cell::Options {
                min_class: value("--min-class")?
                    .map(|c| {
                        ways::ROAD_CLASSES
                            .iter()
                            .position(|k| k == c)
                            .map(|i| i as u8)
                            .ok_or_else(|| format!("unknown road class {c}"))
                    })
                    .transpose()?,
                simplify: value("--simplify")?.map_or(Ok(0.0), |m| m.parse())?,
                terrain: value("--terrain")?.map_or(Ok(cell::TERRAIN_N), |n| n.parse())?,
                markings: flag("--no-markings").is_none(),
                sidewalks: flag("--no-sidewalks").is_none(),
            };
            let (mut client, data) = match fixture {
                Some(_) => (None, None),
                None => (
                    Some(postgres::Client::connect(&db, postgres::NoTls)?),
                    Some(data_dir()?),
                ),
            };
            let out = match value("--out")? {
                Some(o) => PathBuf::from(o),
                None => data.clone().unwrap_or(data_dir()?).join("rust-cells"),
            };
            for c in &cells {
                let started = std::time::Instant::now();
                let source = match (&fixture, client.as_mut(), data.as_deref()) {
                    (Some(ways), _, _) => cell::Source::Fixture { ways, height },
                    (None, Some(db), Some(data)) => cell::Source::Postgres { db, data },
                    _ => unreachable!(),
                };
                let built = cell::build(source, c, &options, pictures.as_deref())?;
                let dir = out.join(&c.token);
                std::fs::create_dir_all(&dir)?;
                std::fs::write(dir.join("ground.arrow"), &built.ground)?;
                std::fs::write(dir.join("ground_triangles.arrow"), &built.triangles)?;
                println!("cell {} built in {:.0?}", c.token, started.elapsed());
                for line in &built.log {
                    println!("  {line}");
                }
                println!("wrote {}", dir.display());
            }
            Ok(())
        }
        Some("serve") => {
            let port = match flag("--port") {
                Some(i) => args.get(i + 1).ok_or(USAGE)?.parse()?,
                None => 5175,
            };
            serve::serve(port, data_dir()?, db)
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
