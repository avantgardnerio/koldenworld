//! The game's database: Aurora DSQL (serverless, Postgres-compatible), reached with tokio-postgres over TLS and an IAM
//! auth token in place of a password (the AWS SDK's usual credentials: AWS_PROFILE locally, the function's role on
//! Lambda). The cluster's endpoint is DSQL_ENDPOINT.
//!
//! Migrations are plain SQL, forward only, in migrations/ (embedded here), applied in order by `cellgen migrate` as
//! DSQL's admin and recorded in schema_migrations. DSQL runs one DDL statement per transaction, so each statement (a
//! file split on blank-line-separated `;` ends) runs on its own. The server connects as APP_ROLE, which `migrate`
//! maps to the function's IAM role.

use aws_config::BehaviorVersion;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_postgres::Client;

/// Where the cluster is, unless DSQL_REGION says otherwise (the bucket's region).
const REGION: &str = "us-east-2";
/// The role the server connects as.
pub const APP_ROLE: &str = "koldenworld_app";
/// DSQL closes a connection after an hour; reconnect well before.
const MAX_AGE: Duration = Duration::from_secs(50 * 60);

/// The migrations, in order: (version, file name, SQL).
const MIGRATIONS: [(i32, &str, &str); 1] = [(
    1,
    "0001_users_sessions.sql",
    include_str!("../migrations/0001_users_sessions.sql"),
)];

/// One connection per process, made on first use and remade when it's closed or old.
pub struct Db {
    endpoint: String,
    connection: tokio::sync::Mutex<Option<(Arc<Client>, Instant)>>,
}

impl Db {
    /// The database at DSQL_ENDPOINT, or None without one (no sign-in).
    pub fn from_env() -> Option<Db> {
        let endpoint = std::env::var("DSQL_ENDPOINT")
            .ok()
            .filter(|e| !e.is_empty())?;
        Some(Db::new(endpoint))
    }

    /// The database at `endpoint`, connected on first use.
    pub fn new(endpoint: String) -> Db {
        Db {
            endpoint,
            connection: tokio::sync::Mutex::new(None),
        }
    }

    /// A connection as APP_ROLE.
    pub async fn client(&self) -> Result<Arc<Client>, String> {
        let mut held = self.connection.lock().await;
        if let Some((client, at)) = held.as_ref()
            && !client.is_closed()
            && at.elapsed() < MAX_AGE
        {
            return Ok(client.clone());
        }
        let client = Arc::new(connect(&self.endpoint, APP_ROLE).await?);
        *held = Some((client.clone(), Instant::now()));
        Ok(client)
    }
}

/// Applies the migrations not yet applied, as admin, then maps APP_ROLE to `app_role_arn` (the function's IAM role).
pub async fn migrate(endpoint: &str, app_role_arn: &str) -> Result<(), String> {
    let db = connect(endpoint, "admin").await?;
    let e = |e: tokio_postgres::Error| e.to_string();
    db.batch_execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    )
    .await
    .map_err(e)?;
    for (version, name, sql) in MIGRATIONS {
        let applied = db
            .query_opt(
                "SELECT 1 FROM schema_migrations WHERE version = $1",
                &[&version],
            )
            .await
            .map_err(e)?;
        if applied.is_some() {
            continue;
        }
        for statement in statements(sql) {
            db.batch_execute(&statement)
                .await
                .map_err(|err| format!("{name}: {err}: {statement}"))?;
        }
        db.execute(
            "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
            &[&version, &name],
        )
        .await
        .map_err(e)?;
        println!("applied {name}");
    }
    let mapped = db
        .query_opt(
            "SELECT 1 FROM sys.iam_pg_role_mappings WHERE pg_role_name = $1 AND arn = $2",
            &[&APP_ROLE, &app_role_arn],
        )
        .await
        .map_err(e)?;
    if mapped.is_none() {
        db.batch_execute(&format!("AWS IAM GRANT {APP_ROLE} TO '{app_role_arn}'"))
            .await
            .map_err(e)?;
        println!("{APP_ROLE} mapped to {app_role_arn}");
    }
    Ok(())
}

/// A file's statements: split where a line ends with `;`, comments dropped.
fn statements(sql: &str) -> Vec<String> {
    let mut all = Vec::new();
    let mut current = String::new();
    for line in sql.lines() {
        let line = line.split("--").next().unwrap_or("").trim_end();
        if line.trim().is_empty() {
            continue;
        }
        current.push_str(line);
        current.push('\n');
        if line.ends_with(';') {
            all.push(std::mem::take(&mut current));
        }
    }
    if !current.trim().is_empty() {
        all.push(current);
    }
    all
}

/// Connects as `user` ("admin", or a role mapped to the caller's IAM identity) with a fresh auth token.
async fn connect(endpoint: &str, user: &str) -> Result<Client, String> {
    let region = std::env::var("DSQL_REGION").unwrap_or_else(|_| REGION.into());
    let sdk = aws_config::defaults(BehaviorVersion::latest())
        .region(aws_config::Region::new(region.clone()))
        .load()
        .await;
    let signer = aws_sdk_dsql::auth_token::AuthTokenGenerator::new(
        aws_sdk_dsql::auth_token::Config::builder()
            .hostname(endpoint)
            .region(aws_config::Region::new(region))
            .build()
            .map_err(|e| e.to_string())?,
    );
    let token = if user == "admin" {
        signer.db_connect_admin_auth_token(&sdk).await
    } else {
        signer.db_connect_auth_token(&sdk).await
    }
    .map_err(|e| format!("DSQL auth token: {e}"))?;
    let mut config = tokio_postgres::Config::new();
    config
        .host(endpoint)
        .port(5432)
        .user(user)
        .password(token.as_str())
        .dbname("postgres")
        .ssl_mode(tokio_postgres::config::SslMode::Require);
    // rustls' process-wide crypto: aws-lc-rs, as the SDK's. Already installed is fine.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let tls = tokio_postgres_rustls::MakeRustlsConnect::with_webpki_roots();
    let (client, connection) = config
        .connect(tls)
        .await
        .map_err(|e| format!("DSQL {endpoint} as {user}: {e}"))?;
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("DSQL connection: {e}");
        }
    });
    Ok(client)
}
