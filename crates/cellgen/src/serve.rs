//! The cell server: GET /cells/<token>/ground.arrow and /cells/<token>/ground_triangles.arrow (and a coarse tile's
//! buildings.arrow and buildings_triangles.arrow), built on a miss and cached as files under data/rust-cells/<token>/:
//! the inputs loaded at once (queries on pooled connections), then built on Tokio's blocking pool. Requests for a cell
//! being built wait for that one build. A fine cell or coarse tile first has the OSM areas it draws from imported
//! (areas.rs); GET /ensure/<area token> does just that, for the TS cell server.

use crate::areas::Areas;
use crate::cell::{self, Cell};
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Router, routing::get};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Every cell's tables, and a coarse tile's buildings.
const TABLES: [&str; 4] = [
    "ground.arrow",
    "ground_triangles.arrow",
    "buildings.arrow",
    "buildings_triangles.arrow",
];

struct App {
    data: PathBuf,                                                 // data/ (dem/ under it)
    cache: PathBuf,                                                // data/rust-cells/
    pool: deadpool_postgres::Pool,                                 // Postgres connections
    areas: Areas,                                                  // OSM areas imported on demand
    building: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>, // a lock per cell being asked for
}

/// Serves on 127.0.0.1:`port` until stopped.
pub fn serve(
    port: u16,
    data: PathBuf,
    pool: deadpool_postgres::Pool,
) -> Result<(), Box<dyn std::error::Error>> {
    tokio::runtime::Runtime::new()?.block_on(async {
        let areas = Areas::new(data.clone(), pool.clone())
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        println!("{} OSM areas imported", areas.imported());
        let app = Arc::new(App {
            cache: data.join("rust-cells"),
            data,
            pool,
            areas,
            building: Mutex::default(),
        });
        let router = Router::new()
            .route("/cells/{token}/{table}", get(table))
            .route("/ensure/{token}", get(ensure))
            .with_state(app);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
        println!(
            "cell server on http://127.0.0.1:{port}/cells/<token>/{{{}}}",
            TABLES.join(",")
        );
        axum::serve(listener, router).await
    })?;
    Ok(())
}

/// An OSM download area imported (fetched first if need be), for the TS cell server.
async fn ensure(State(app): State<Arc<App>>, Path(token): Path<String>) -> Response {
    match app.areas.ensure(&token).await {
        Ok(()) => (StatusCode::OK, "imported\n").into_response(),
        Err(e) => {
            eprintln!("area {token}: {e}");
            (StatusCode::BAD_GATEWAY, format!("{e}\n")).into_response()
        }
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
    if table.starts_with("buildings") && c.level != cell::COARSE_LEVEL {
        return (
            StatusCode::NOT_FOUND,
            "only coarse tiles have massing (fine cells' buildings come from the TS cell server)\n",
        )
            .into_response();
    }
    let file = app.cache.join(&token).join(&table);
    if !file.exists() {
        // One build per cell: whoever gets its lock first builds, the rest find the files.
        let lock = app
            .building
            .lock()
            .unwrap()
            .entry(token.clone())
            .or_default()
            .clone();
        let _held = lock.lock().await;
        if !file.exists()
            && let Err(e) = build(app.clone(), c).await
        {
            eprintln!("cell {token}: {e}");
            return (StatusCode::BAD_GATEWAY, format!("{e}\n")).into_response();
        }
    }
    match tokio::fs::read(&file).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, "application/vnd.apache.arrow.file"),
                (header::CACHE_CONTROL, "no-store"),
                (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
            ],
            bytes,
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e}\n")).into_response(),
    }
}

/// Builds a cell and writes its tables (each to a temporary name, then renamed, so a reader never sees half a file).
async fn build(app: Arc<App>, c: Cell) -> Result<(), cell::LoadError> {
    let started = std::time::Instant::now();
    let options = cell::Options::for_level(c.level);
    // Far tiles draw only terrain, land cover and water already there: no OSM fetched for 70 km at a time.
    if c.level > cell::FAR_LEVEL {
        app.areas.ensure_cell(&c).await?;
    }
    let inputs = cell::Inputs::load(&app.pool, &app.data, &c, &options).await?;
    let loaded = started.elapsed();
    tokio::task::spawn_blocking(move || -> Result<(), cell::LoadError> {
        let built = cell::build(inputs, &c, &options, None).map_err(|e| e.to_string())?;
        let dir = app.cache.join(&c.token);
        std::fs::create_dir_all(&dir)?;
        let mut tables = vec![
            ("ground.arrow", &built.ground),
            ("ground_triangles.arrow", &built.triangles),
        ];
        if let Some((v, t)) = &built.buildings {
            tables.push(("buildings.arrow", v));
            tables.push(("buildings_triangles.arrow", t));
        }
        for (name, bytes) in tables {
            let tmp = dir.join(format!("{name}.tmp"));
            std::fs::write(&tmp, bytes)?;
            std::fs::rename(&tmp, dir.join(name))?;
        }
        println!(
            "cell {} built in {:.0?} (loaded in {loaded:.0?})",
            c.token,
            started.elapsed()
        );
        for line in &built.log {
            println!("  {line}");
        }
        Ok(())
    })
    .await?
}
