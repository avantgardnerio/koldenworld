mod cell;
mod clip;
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
mod terrain;
mod water;
mod ways;
mod widths;

use std::path::PathBuf;

const USAGE: &str = "usage:
  cellgen cell <token | lat,lon> [--pictures]   build one cell: data/rust-cells/<token>/, pictures in target/
  cellgen serve [--port <port>]                 cell server on 127.0.0.1 (default port 5175)

The database is CELLGEN_DB (default: the local socket, as the game role); the data directory (dem/ and the cache)
is GAME_DATA (default: the repo's data/, found from here up).";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().position(|a| a == name);
    let db = std::env::var("CELLGEN_DB")
        .unwrap_or_else(|_| "host=/var/run/postgresql user=game dbname=game".into());
    let data = data_dir()?;
    match args.first().map(String::as_str) {
        Some("cell") => {
            let what = args.get(1).ok_or(USAGE)?;
            let c = match what.split_once(',') {
                Some((lat, lon)) => cell::Cell::at(lat.trim().parse()?, lon.trim().parse()?),
                None => {
                    cell::Cell::from_token(what).ok_or(format!("{what} isn't a level-13 cell"))?
                }
            };
            let pictures = flag("--pictures").map(|_| PathBuf::from("target"));
            let started = std::time::Instant::now();
            let mut client = postgres::Client::connect(&db, postgres::NoTls)?;
            let built = cell::build(&mut client, &data, &c, pictures.as_deref())?;
            let dir = data.join("rust-cells").join(&c.token);
            std::fs::create_dir_all(&dir)?;
            std::fs::write(dir.join("ground.arrow"), &built.ground)?;
            std::fs::write(dir.join("ground_triangles.arrow"), &built.triangles)?;
            println!("cell {} built in {:.0?}", c.token, started.elapsed());
            for line in &built.log {
                println!("  {line}");
            }
            println!("wrote {}", dir.display());
            Ok(())
        }
        Some("serve") => {
            let port = match flag("--port") {
                Some(i) => args.get(i + 1).ok_or(USAGE)?.parse()?,
                None => 5175,
            };
            serve::serve(port, data, db)
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
