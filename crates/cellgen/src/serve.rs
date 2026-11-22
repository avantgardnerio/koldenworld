//! The cell server: GET /cells/<token>/ground.arrow and /cells/<token>/ground_triangles.arrow, built on a miss (on
//! Tokio's blocking pool, a Postgres connection each) and cached as files under data/rust-cells/<token>/. Requests for a
//! cell being built wait for that one build.

use crate::cell::{self, Cell};
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Router, routing::get};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const TABLES: [&str; 2] = ["ground.arrow", "ground_triangles.arrow"];

struct App {
    data: PathBuf,                                                 // data/ (dem/ under it)
    cache: PathBuf,                                                // data/rust-cells/
    db: String,                                                    // Postgres connection string
    building: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>, // a lock per cell being asked for
}

/// Serves on 127.0.0.1:`port` until stopped.
pub fn serve(port: u16, data: PathBuf, db: String) -> Result<(), Box<dyn std::error::Error>> {
    let app = Arc::new(App {
        cache: data.join("rust-cells"),
        data,
        db,
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
            format!("{token} isn't a level-13 cell\n"),
        )
            .into_response();
    };
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
        if !file.exists() {
            let app2 = app.clone();
            let built = tokio::task::spawn_blocking(move || build(&app2, &c)).await;
            match built {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    eprintln!("cell {token}: {e}");
                    return (StatusCode::BAD_GATEWAY, format!("{e}\n")).into_response();
                }
                Err(e) => {
                    return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e}\n")).into_response();
                }
            }
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
fn build(app: &App, c: &Cell) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let started = std::time::Instant::now();
    let mut db = postgres::Client::connect(&app.db, postgres::NoTls)?;
    let built = cell::build(
        cell::Source::Postgres {
            db: &mut db,
            data: &app.data,
        },
        c,
        &cell::Options::default(),
        None,
    )
    .map_err(|e| e.to_string())?;
    let dir = app.cache.join(&c.token);
    std::fs::create_dir_all(&dir)?;
    for (name, bytes) in TABLES.iter().zip([&built.ground, &built.triangles]) {
        let tmp = dir.join(format!("{name}.tmp"));
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, dir.join(name))?;
    }
    println!("cell {} built in {:.0?}", c.token, started.elapsed());
    for line in &built.log {
        println!("  {line}");
    }
    Ok(())
}
