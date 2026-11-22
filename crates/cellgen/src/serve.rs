//! The cell server: GET /cells/<token>/ground.arrow and /cells/<token>/ground_triangles.arrow (and a coarse tile's
//! buildings.arrow and buildings_triangles.arrow), built on a miss and cached as files under data/rust-cells/<token>/:
//! the inputs loaded at once (queries on pooled connections), then built on Tokio's blocking pool. Requests for a cell
//! being built wait for that one build.

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
    building: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>, // a lock per cell being asked for
}

/// Serves on 127.0.0.1:`port` until stopped.
pub fn serve(
    port: u16,
    data: PathBuf,
    pool: deadpool_postgres::Pool,
) -> Result<(), Box<dyn std::error::Error>> {
    let app = Arc::new(App {
        cache: data.join("rust-cells"),
        data,
        pool,
        building: Mutex::default(),
    });
    let router = Router::new()
        .route("/cells/{token}/{table}", get(table))
        .with_state(app);
    tokio::runtime::Runtime::new()?.block_on(async {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
        println!(
            "cell server on http://127.0.0.1:{port}/cells/<token>/{{{}}}",
            TABLES.join(",")
        );
        axum::serve(listener, router).await
    })?;
    Ok(())
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
    if table.starts_with("buildings") && c.level > cell::COARSE_LEVEL {
        return (
            StatusCode::NOT_FOUND,
            "fine cells' buildings come from the TS cell server\n",
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
    let inputs = cell::Inputs::load(&app.pool, &app.data, &c).await?;
    let loaded = started.elapsed();
    tokio::task::spawn_blocking(move || -> Result<(), cell::LoadError> {
        let built = cell::build(inputs, &c, &cell::Options::for_level(c.level), None)
            .map_err(|e| e.to_string())?;
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
