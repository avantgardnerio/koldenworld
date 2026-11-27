//! The game's server, the one thing deployed (the container): with --static, the viewer's release build (vite build)
//! at /, and the cells: GET /ground/<token>/ground.arrow, ground_triangles.arrow and terrain.arrow (and a coarse tile's
//! buildings.arrow and buildings_triangles.arrow massing, a fine cell's buildings.arrow, pois.arrow, nodes.arrow and
//! edges.arrow). Built cells live in S3, shared by every instance: cells/<data>/<format>/<token>/<table>.arrow under
//! CELLGEN_CELLS_S3 (default CELLS_S3), where <data> names the OSM cell files they're built from and <format> the
//! tables' versions, so neither new data nor a new format serves stale cells. On a miss the cell is built (its inputs
//! from the cell files and elevation data, Inputs::from_files, then cell::build, on Tokio's blocking pool), every table
//! written to S3, and the one asked for answered. Requests here for a cell being built wait for that one build.
//! GET /aircraft?lat=&lon=&nm= answers with live air traffic around a point (aircraft.rs).

use crate::aircraft::Aircraft;
use crate::cell::{self, Cell};
use crate::s3;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Router, routing::get};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Every cell's tables, and a coarse tile's buildings.
const TABLES: [&str; 8] = [
    "ground.arrow",
    "ground_triangles.arrow",
    "terrain.arrow",
    "pois.arrow",
    "nodes.arrow",
    "edges.arrow",
    "buildings.arrow",
    "buildings_triangles.arrow",
];

/// Where built cells go, unless CELLGEN_CELLS_S3 says otherwise.
const CELLS_S3: &str = "s3://koldenworld-data-2/cells";
const ARROW: &str = "application/vnd.apache.arrow.file";

struct App {
    cells: String,      // s3://…/cells/<data>/<format>: where this server's built cells are
    aircraft: Aircraft, // live air traffic, rate-limited
    building: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>, // a lock per cell being asked for
}

/// Serves on `host`:`port` until stopped; with `site`, its files at / (index.html for a directory).
pub fn serve(
    host: &str,
    port: u16,
    site: Option<std::path::PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    let aircraft = Aircraft::new()?;
    tokio::runtime::Runtime::new()?.block_on(async {
        let cells = format!(
            "{}/{}/g{}-r{}-b{}",
            std::env::var("CELLGEN_CELLS_S3")
                .unwrap_or_else(|_| CELLS_S3.into())
                .trim_end_matches('/'),
            crate::local::source_name(),
            cell::GROUND_VERSION,
            crate::road_table::ROAD_GRAPH_VERSION,
            crate::building_table::BUILDINGS_VERSION
        );
        println!("built cells in {cells}/<token>/");
        let app = Arc::new(App {
            cells,
            aircraft,
            building: Mutex::default(),
        });
        let mut router = Router::new()
            .route("/ground/{token}/{table}", get(table))
            .route("/aircraft", get(air_traffic))
            .with_state(app);
        if let Some(site) = &site {
            router = router.fallback_service(tower_http::services::ServeDir::new(site));
            println!("the viewer from {}", site.display());
        }
        let router = router.layer(axum::middleware::from_fn(log));
        let listener = tokio::net::TcpListener::bind((host, port)).await?;
        println!(
            "on http://{host}:{port}/: /ground/<token>/{{{}}}, /aircraft",
            TABLES.join(",")
        );
        axum::serve(listener, router).await
    })?;
    Ok(())
}

/// One line per request (stdout: CloudWatch on Lambda): status, time taken, method, path and query, and who asked:
/// the client's address as CloudFront forwards it, and its user agent.
async fn log(request: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let started = std::time::Instant::now();
    // In a block: a borrow of the request (its body isn't Sync) held over the await would make the future not Send.
    let (client, agent) = {
        let header = |name| {
            let value = request.headers().get(name).and_then(|v| v.to_str().ok());
            value.unwrap_or("-").to_owned()
        };
        (header("x-forwarded-for"), header("user-agent"))
    };
    let (method, uri) = (request.method().clone(), request.uri().clone());
    let response = next.run(request).await;
    println!(
        "{} {:.0?} {method} {uri} {client} {agent:?}",
        response.status().as_u16(),
        started.elapsed()
    );
    response
}

/// Live air traffic around a point: ?lat=&lon=&nm= (nautical miles).
async fn air_traffic(
    State(app): State<Arc<App>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let number = |k: &str| {
        q.get(k)
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite())
    };
    let (Some(lat), Some(lon), Some(nm)) = (number("lat"), number("lon"), number("nm")) else {
        return (StatusCode::BAD_REQUEST, "lat, lon and nm are required\n").into_response();
    };
    match app.aircraft.around(lat, lon, nm).await {
        Ok(body) => (
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            body,
        )
            .into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, format!("{e}\n")).into_response(),
    }
}

async fn table(
    State(app): State<Arc<App>>,
    Path((token, table)): Path<(String, String)>,
) -> Response {
    if !TABLES.contains(&table.as_str()) {
        return (StatusCode::NOT_FOUND, "not found\n").into_response();
    }
    let Some(c) = Cell::from_token(&token) else {
        return (
            StatusCode::BAD_REQUEST,
            format!("{token} isn't a cell token\n"),
        )
            .into_response();
    };
    // buildings.arrow: a coarse tile's massing or a fine cell's buildings table; triangles only for massing.
    let has = match table.as_str() {
        "buildings.arrow" => c.level == cell::COARSE_LEVEL || c.level == crate::s2::CELL_LEVEL,
        "buildings_triangles.arrow" => c.level == cell::COARSE_LEVEL,
        "pois.arrow" | "nodes.arrow" | "edges.arrow" => c.level == crate::s2::CELL_LEVEL,
        _ => true,
    };
    if !has {
        return (StatusCode::NOT_FOUND, "no such table at this level\n").into_response();
    }
    let url = format!("{}/{token}/{table}", app.cells);
    let found = |bytes: Vec<u8>| {
        (
            [
                (header::CONTENT_TYPE, ARROW),
                (header::CACHE_CONTROL, "no-store"),
                (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
            ],
            bytes,
        )
            .into_response()
    };
    let failed = |e: String| {
        eprintln!("cell {token}: {e}");
        (StatusCode::BAD_GATEWAY, format!("{e}\n")).into_response()
    };
    match s3::get(&url).await {
        Ok(Some(bytes)) => return found(bytes),
        Ok(None) => {}
        Err(e) => return failed(e),
    }
    // One build per cell here: whoever gets its lock first builds, the rest find the tables in S3.
    let lock = app
        .building
        .lock()
        .unwrap()
        .entry(token.clone())
        .or_default()
        .clone();
    let _held = lock.lock().await;
    match s3::get(&url).await {
        Ok(Some(bytes)) => return found(bytes),
        Ok(None) => {}
        Err(e) => return failed(e),
    }
    match build(app.clone(), c).await {
        Ok(mut tables) => match tables.remove(table.as_str()) {
            Some(bytes) => found(bytes),
            None => (StatusCode::NOT_FOUND, "no such table for this cell\n").into_response(),
        },
        Err(e) => failed(e.to_string()),
    }
}

/// Builds a cell and writes every table to S3; the tables, by file name.
async fn build(app: Arc<App>, c: Cell) -> Result<HashMap<&'static str, Vec<u8>>, cell::LoadError> {
    let started = std::time::Instant::now();
    let options = cell::Options::for_level(c.level);
    let inputs = {
        let (c, options) = (c.clone(), options.clone());
        tokio::task::spawn_blocking(move || cell::Inputs::from_files(&c, &options)).await??
    };
    let loaded = started.elapsed();
    let token = c.token.clone();
    let (tables, log) = tokio::task::spawn_blocking(move || -> Result<_, cell::LoadError> {
        let built = cell::build(inputs, &c, &options, None).map_err(|e| e.to_string())?;
        let mut tables = HashMap::from([
            ("ground.arrow", built.ground),
            ("ground_triangles.arrow", built.triangles),
            ("terrain.arrow", built.terrain),
        ]);
        if let Some(b) = built.fine_buildings {
            tables.insert("buildings.arrow", b);
        }
        if let Some(p) = built.fine_pois {
            tables.insert("pois.arrow", p);
        }
        if let Some((nodes, edges)) = built.fine_graph {
            tables.insert("nodes.arrow", nodes);
            tables.insert("edges.arrow", edges);
        }
        if let Some((v, t)) = built.buildings {
            tables.insert("buildings.arrow", v);
            tables.insert("buildings_triangles.arrow", t);
        }
        Ok((tables, built.log))
    })
    .await??;
    let built = started.elapsed();
    let mut puts = tokio::task::JoinSet::new();
    for (name, bytes) in &tables {
        let url = format!("{}/{token}/{name}", app.cells);
        let bytes = bytes.clone();
        puts.spawn(async move { s3::put(&url, bytes, ARROW).await });
    }
    while let Some(put) = puts.join_next().await {
        put??;
    }
    println!(
        "cell {token} built in {built:.0?} (loaded in {loaded:.0?}), written to S3 in {:.0?}",
        started.elapsed() - built
    );
    for line in &log {
        println!("  {line}");
    }
    Ok(tables)
}
