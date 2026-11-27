-- Players (anyone who signs in with Google) and their sessions. Aurora DSQL: one statement per transaction (db.rs runs
-- them one at a time), no foreign keys. The server reads and writes as koldenworld_app (mapped to the function's IAM
-- role by `cellgen migrate`).

CREATE TABLE users (
  google_sub text PRIMARY KEY,
  email text NOT NULL,
  name text,
  picture text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login timestamptz NOT NULL DEFAULT now()
);

-- A session is the SHA-256 of its cookie's token (hex): the database never holds a usable token.
CREATE TABLE sessions (
  token_sha256 text PRIMARY KEY,
  google_sub text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE ROLE koldenworld_app WITH LOGIN;

GRANT SELECT, INSERT, UPDATE ON users TO koldenworld_app;

GRANT SELECT, INSERT, DELETE ON sessions TO koldenworld_app;
