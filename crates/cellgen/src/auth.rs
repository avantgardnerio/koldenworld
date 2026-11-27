//! Sign-in with Google, for anyone with a Google account, and what lets a signed-in browser at the cells and air
//! traffic: CloudFront's own signed cookies (CloudFront-Policy, -Signature, -Key-Pair-Id), checked by CloudFront at the
//! edge (its key group, deploy/app.yml) before its cache or this server, and checked here too (`allowed`) where there's
//! no CloudFront in front (local dev) so the game behaves the same.
//!
//! - GET /auth/google?then=<path>: to Google's consent screen, with a random state (also in a short cookie).
//! - GET /auth/google/callback: Google's answer; the code traded for an ID token (straight from Google over TLS, with
//!   our secret, so its claims are Google's), the player saved, a session made, the cookies set, back to <path>.
//! - GET /auth/me: the signed-in player (and fresh CloudFront cookies), or 401.
//! - GET /auth/logout: the session ended, the cookies cleared.
//!
//! Configured from the environment: AUTH_ORIGIN (the public origin Google redirects to, default http://localhost:5173),
//! GOOGLE_CLIENT_ID, and in SSM Parameter Store (SecureString) the client secret (GOOGLE_CLIENT_SECRET_SSM) and the
//! CloudFront signing key (CLOUDFRONT_KEY_SSM, a PKCS#1 PEM RSA key) with its key pair id (CLOUDFRONT_KEY_PAIR_ID); and
//! the database (db.rs). Without GOOGLE_CLIENT_ID there's no sign-in and everything is open. AUTH_AT_EDGE=1 (on
//! Lambda, behind CloudFront) leaves the check to CloudFront, which doesn't pass its cookies on.

use crate::db::Db;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::signature::{Keypair, SignatureEncoding, Signer, Verifier};
use sha2::Digest;
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How long a session (and its CloudFront cookies, refreshed by /auth/me) lasts.
const SESSION: Duration = Duration::from_secs(30 * 24 * 3600);
/// How long the consent screen may take.
const STATE: Duration = Duration::from_secs(10 * 60);
const SESSION_COOKIE: &str = "kw_session";
const STATE_COOKIE: &str = "kw_state";
/// Where the SSM parameters are, unless SSM_REGION says otherwise.
const REGION: &str = "us-east-2";

const GOOGLE_AUTH: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN: &str = "https://oauth2.googleapis.com/token";

pub struct Auth {
    origin: String, // https://koldenworld.squarelabs.net: where Google sends the browser back
    client_id: String,
    client_secret: String,
    key: rsa::pkcs1v15::SigningKey<sha1::Sha1>,
    key_pair_id: String,
    at_edge: bool,
    db: Db,
    http: reqwest::Client,
}

/// A signed-in player.
struct Player {
    sub: String,
    email: String,
    name: Option<String>,
    picture: Option<String>,
}

impl Auth {
    /// Sign-in as configured (above), None without GOOGLE_CLIENT_ID.
    pub async fn from_env() -> Result<Option<Auth>, String> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let Some(client_id) = var("GOOGLE_CLIENT_ID") else {
            return Ok(None);
        };
        let required = |k: &str| var(k).ok_or(format!("{k} is required with GOOGLE_CLIENT_ID"));
        let region = var("SSM_REGION").unwrap_or_else(|| REGION.into());
        let sdk = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new(region))
            .load()
            .await;
        let ssm = aws_sdk_ssm::Client::new(&sdk);
        let secret = async |name: String| {
            let got = ssm
                .get_parameter()
                .name(&name)
                .with_decryption(true)
                .send()
                .await;
            got.map_err(|e| format!("SSM {name}: {}", aws_sdk_ssm::error::DisplayErrorContext(e)))?
                .parameter
                .and_then(|p| p.value)
                .ok_or(format!("SSM {name} has no value"))
        };
        let client_secret = secret(required("GOOGLE_CLIENT_SECRET_SSM")?).await?;
        let pem = secret(required("CLOUDFRONT_KEY_SSM")?).await?;
        let key =
            rsa::PrivateKey::from_pkcs1_pem(&pem).map_err(|e| format!("CloudFront key: {e}"))?;
        Ok(Some(Auth {
            origin: var("AUTH_ORIGIN")
                .unwrap_or_else(|| "http://localhost:5173".into())
                .trim_end_matches('/')
                .into(),
            client_id,
            client_secret,
            key: rsa::pkcs1v15::SigningKey::new(key),
            key_pair_id: required("CLOUDFRONT_KEY_PAIR_ID")?,
            at_edge: var("AUTH_AT_EDGE").is_some_and(|v| v == "1"),
            db: Db::from_env().ok_or("DSQL_ENDPOINT is required with GOOGLE_CLIENT_ID")?,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .map_err(|e| e.to_string())?,
        }))
    }

    /// Whether a request may have cells and air traffic: CloudFront cookies signed by our key, not yet expired.
    pub fn allowed(&self, headers: &HeaderMap) -> bool {
        if self.at_edge {
            return true;
        }
        let cookies = cookies(headers);
        let (Some(policy), Some(signature)) = (
            cookies.get("CloudFront-Policy"),
            cookies.get("CloudFront-Signature"),
        ) else {
            return false;
        };
        let (Some(policy), Some(signature)) = (from_cloudfront(policy), from_cloudfront(signature))
        else {
            return false;
        };
        let Ok(signature) = rsa::pkcs1v15::Signature::try_from(signature.as_slice()) else {
            return false;
        };
        if self
            .key
            .verifying_key()
            .verify(&policy, &signature)
            .is_err()
        {
            return false;
        }
        let expires = serde_json::from_slice::<serde_json::Value>(&policy)
            .ok()
            .and_then(|p| p["Statement"][0]["Condition"]["DateLessThan"]["AWS:EpochTime"].as_u64());
        expires.is_some_and(|t| t > now())
    }

    /// GET /auth/google?then=<path>
    pub fn start(&self, query: &HashMap<String, String>) -> Response {
        let state = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 24]>());
        let then = query
            .get("then")
            .map(String::as_str)
            .filter(|t| local_path(t))
            .unwrap_or("/");
        let url = reqwest::Url::parse_with_params(
            GOOGLE_AUTH,
            [
                ("client_id", self.client_id.as_str()),
                ("redirect_uri", &self.redirect_uri()),
                ("response_type", "code"),
                ("scope", "openid email profile"),
                ("state", &state),
                ("prompt", "select_account"),
            ],
        )
        .expect("Google's URL");
        let value = format!("{state}|{then}");
        (
            StatusCode::FOUND,
            [
                (header::LOCATION, url.to_string()),
                (
                    header::SET_COOKIE,
                    self.cookie(STATE_COOKIE, &URL_SAFE_NO_PAD.encode(value), STATE),
                ),
                (header::CACHE_CONTROL, "no-store".into()),
            ],
        )
            .into_response()
    }

    /// GET /auth/google/callback?code=&state=
    pub async fn callback(&self, query: &HashMap<String, String>, headers: &HeaderMap) -> Response {
        let saved = cookies(headers)
            .get(STATE_COOKIE)
            .and_then(|v| URL_SAFE_NO_PAD.decode(v).ok())
            .and_then(|v| String::from_utf8(v).ok());
        let Some((state, then)) = saved.as_deref().and_then(|s| s.split_once('|')) else {
            return refuse("sign-in expired: try again");
        };
        if query.get("state").map(String::as_str) != Some(state) {
            return refuse("sign-in state doesn't match: try again");
        }
        let Some(code) = query.get("code") else {
            return refuse("Google sent no code (sign-in declined?)");
        };
        let player = match self.player(code).await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("sign-in: {e}");
                return (StatusCode::BAD_GATEWAY, "sign-in failed\n").into_response();
            }
        };
        let token = match self.begin(&player).await {
            Ok(t) => t,
            Err(e) => {
                eprintln!("sign-in: {e}");
                return (StatusCode::BAD_GATEWAY, "sign-in failed\n").into_response();
            }
        };
        println!("signed in: {} ({})", player.email, player.sub);
        let mut response = (
            StatusCode::FOUND,
            [
                (header::LOCATION, then),
                (header::CACHE_CONTROL, "no-store"),
            ],
        )
            .into_response();
        let h = response.headers_mut();
        h.append(
            header::SET_COOKIE,
            self.cookie(SESSION_COOKIE, &token, SESSION)
                .parse()
                .unwrap(),
        );
        h.append(
            header::SET_COOKIE,
            self.cookie(STATE_COOKIE, "", Duration::ZERO)
                .parse()
                .unwrap(),
        );
        for c in self.cloudfront_cookies(SESSION) {
            h.append(header::SET_COOKIE, c.parse().unwrap());
        }
        response
    }

    /// GET /auth/me
    pub async fn me(&self, headers: &HeaderMap) -> Response {
        let player = match self.session(headers).await {
            Ok(Some(p)) => p,
            Ok(None) => {
                return (
                    StatusCode::UNAUTHORIZED,
                    [(header::CACHE_CONTROL, "no-store")],
                    "not signed in\n",
                )
                    .into_response();
            }
            Err(e) => {
                eprintln!("session: {e}");
                return (StatusCode::BAD_GATEWAY, "sessions unavailable\n").into_response();
            }
        };
        let body = serde_json::json!({
            "email": player.email, "name": player.name, "picture": player.picture,
        });
        let mut response = (
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            body.to_string(),
        )
            .into_response();
        for c in self.cloudfront_cookies(SESSION) {
            response
                .headers_mut()
                .append(header::SET_COOKIE, c.parse().unwrap());
        }
        response
    }

    /// GET /auth/logout
    pub async fn logout(&self, headers: &HeaderMap) -> Response {
        if let Some(token) = cookies(headers).get(SESSION_COOKIE) {
            let ended = async {
                let db = self.db.client().await?;
                db.execute(
                    "DELETE FROM sessions WHERE token_sha256 = $1",
                    &[&sha256(token)],
                )
                .await
                .map_err(|e| e.to_string())
            };
            if let Err(e) = ended.await {
                eprintln!("logout: {e}");
            }
        }
        let mut response = (
            StatusCode::FOUND,
            [(header::LOCATION, "/"), (header::CACHE_CONTROL, "no-store")],
        )
            .into_response();
        for name in [
            SESSION_COOKIE,
            "CloudFront-Policy",
            "CloudFront-Signature",
            "CloudFront-Key-Pair-Id",
        ] {
            let gone = self.cookie(name, "", Duration::ZERO);
            response
                .headers_mut()
                .append(header::SET_COOKIE, gone.parse().unwrap());
        }
        response
    }

    fn redirect_uri(&self) -> String {
        format!("{}/auth/google/callback", self.origin)
    }

    /// The code traded for the player's ID token's claims.
    async fn player(&self, code: &str) -> Result<Player, String> {
        let answer = self
            .http
            .post(GOOGLE_TOKEN)
            .form(&[
                ("code", code),
                ("client_id", &self.client_id),
                ("client_secret", &self.client_secret),
                ("redirect_uri", &self.redirect_uri()),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = answer.status();
        let body = answer.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("token endpoint {status}: {body}"));
        }
        let tokens: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let id_token = tokens["id_token"].as_str().ok_or("no id_token")?;
        let payload = id_token.split('.').nth(1).ok_or("id_token isn't a JWT")?;
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let text = |k: &str| claims[k].as_str().map(String::from);
        if !matches!(
            claims["iss"].as_str(),
            Some("accounts.google.com" | "https://accounts.google.com")
        ) {
            return Err(format!("issuer {}", claims["iss"]));
        }
        if claims["aud"].as_str() != Some(&self.client_id) {
            return Err(format!("audience {}", claims["aud"]));
        }
        if claims["exp"].as_u64().is_none_or(|t| t <= now()) {
            return Err("expired ID token".into());
        }
        if claims["email_verified"].as_bool() != Some(true) {
            return Err("email not verified".into());
        }
        Ok(Player {
            sub: text("sub").ok_or("no sub")?,
            email: text("email").ok_or("no email")?,
            name: text("name"),
            picture: text("picture"),
        })
    }

    /// The player saved, and a new session's token.
    async fn begin(&self, p: &Player) -> Result<String, String> {
        let db = self.db.client().await?;
        let e = |e: tokio_postgres::Error| e.to_string();
        db.execute(
            "INSERT INTO users (google_sub, email, name, picture) VALUES ($1, $2, $3, $4)
             ON CONFLICT (google_sub) DO UPDATE
             SET email = excluded.email, name = excluded.name, picture = excluded.picture, last_login = now()",
            &[&p.sub, &p.email, &p.name, &p.picture],
        )
        .await
        .map_err(e)?;
        let token = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
        let expires = SystemTime::now() + SESSION;
        db.execute(
            "INSERT INTO sessions (token_sha256, google_sub, expires_at) VALUES ($1, $2, $3)",
            &[&sha256(&token), &p.sub, &expires],
        )
        .await
        .map_err(e)?;
        Ok(token)
    }

    /// The request's session's player, if it has a live one.
    async fn session(&self, headers: &HeaderMap) -> Result<Option<Player>, String> {
        let Some(token) = cookies(headers).get(SESSION_COOKIE).cloned() else {
            return Ok(None);
        };
        let db = self.db.client().await?;
        let row = db
            .query_opt(
                "SELECT u.google_sub, u.email, u.name, u.picture
                 FROM sessions s JOIN users u ON u.google_sub = s.google_sub
                 WHERE s.token_sha256 = $1 AND s.expires_at > now()",
                &[&sha256(&token)],
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(row.map(|r| Player {
            sub: r.get(0),
            email: r.get(1),
            name: r.get(2),
            picture: r.get(3),
        }))
    }

    /// CloudFront's three cookies, for everything under the origin until `lasting` from now.
    fn cloudfront_cookies(&self, lasting: Duration) -> [String; 3] {
        let expires = now() + lasting.as_secs();
        let policy = format!(
            r#"{{"Statement":[{{"Resource":"{}/*","Condition":{{"DateLessThan":{{"AWS:EpochTime":{expires}}}}}}}]}}"#,
            self.origin
        );
        let signature = self.key.sign(policy.as_bytes()).to_bytes();
        [
            self.cookie(
                "CloudFront-Policy",
                &to_cloudfront(policy.as_bytes()),
                lasting,
            ),
            self.cookie("CloudFront-Signature", &to_cloudfront(&signature), lasting),
            self.cookie("CloudFront-Key-Pair-Id", &self.key_pair_id, lasting),
        ]
    }

    /// A Set-Cookie value: the whole site, script can't read it, sent on top-level navigation from elsewhere (Lax, so
    /// Google's redirect back carries the state cookie). Zero `lasting` deletes it.
    fn cookie(&self, name: &str, value: &str, lasting: Duration) -> String {
        let secure = if self.origin.starts_with("https:") {
            "; Secure"
        } else {
            ""
        };
        format!(
            "{name}={value}; Path=/; Max-Age={}; HttpOnly; SameSite=Lax{secure}",
            lasting.as_secs()
        )
    }
}

fn refuse(why: &str) -> Response {
    (StatusCode::BAD_REQUEST, format!("{why}\n")).into_response()
}

/// A path on this site (not //elsewhere): where sign-in may return to.
fn local_path(p: &str) -> bool {
    p.starts_with('/') && !p.starts_with("//") && !p.contains('\\')
}

fn cookies(headers: &HeaderMap) -> HashMap<String, String> {
    let all = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok());
    all.flat_map(|v| v.split(';'))
        .filter_map(|c| c.trim().split_once('='))
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn sha256(token: &str) -> String {
    sha2::Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// CloudFront's base64 for cookies: + - , = _ , / ~.
fn to_cloudfront(bytes: &[u8]) -> String {
    STANDARD
        .encode(bytes)
        .replace('+', "-")
        .replace('=', "_")
        .replace('/', "~")
}

fn from_cloudfront(text: &str) -> Option<Vec<u8>> {
    STANDARD
        .decode(text.replace('-', "+").replace('_', "=").replace('~', "/"))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth(origin: &str) -> Auth {
        let key = rsa::pkcs1v15::SigningKey::random(&mut rand::rng(), 2048).unwrap();
        Auth {
            origin: origin.into(),
            client_id: "id".into(),
            client_secret: "secret".into(),
            key,
            key_pair_id: "K123".into(),
            at_edge: false,
            db: Db::new("nowhere".into()),
            http: reqwest::Client::new(),
        }
    }

    /// The Cookie header a browser sends back for these Set-Cookie values.
    fn sent(set: &[String]) -> HeaderMap {
        let pairs: Vec<&str> = set.iter().map(|c| c.split(';').next().unwrap()).collect();
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, pairs.join("; ").parse().unwrap());
        h
    }

    #[test]
    fn cloudfront_cookies_check_out() {
        let a = auth("https://example.test");
        assert!(a.allowed(&sent(&a.cloudfront_cookies(SESSION))));
        assert!(!a.allowed(&HeaderMap::new()));
        // Expired, signed by another key, or the policy changed: refused.
        assert!(!a.allowed(&sent(&a.cloudfront_cookies(Duration::ZERO))));
        assert!(!auth("https://example.test").allowed(&sent(&a.cloudfront_cookies(SESSION))));
        let mut forged = a.cloudfront_cookies(SESSION);
        let policy = r#"{"Statement":[{"Resource":"https://example.test/*","Condition":{"DateLessThan":{"AWS:EpochTime":9999999999}}}]}"#;
        forged[0] = format!("CloudFront-Policy={}", to_cloudfront(policy.as_bytes()));
        assert!(!a.allowed(&sent(&forged)));
    }

    #[test]
    fn returns_only_to_this_site() {
        assert!(local_path("/?lat=1&lon=2"));
        assert!(!local_path("//evil.test/"));
        assert!(!local_path("https://evil.test/"));
        assert!(!local_path("/\\evil.test"));
    }
}
