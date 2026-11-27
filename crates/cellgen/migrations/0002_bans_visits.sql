-- Banning, and who was where: a banned player can't sign in or renew (CloudFront's cookies last an hour, so a ban
-- takes effect within one), and each sign-in and renewal records the address and browser it came from, so an address
-- in the access logs maps to a player (`cellgen players <address>`).

ALTER TABLE users ADD COLUMN banned_at timestamptz;

CREATE TABLE visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  address text NOT NULL,
  user_agent text NOT NULL
);

GRANT SELECT, INSERT ON visits TO koldenworld_app;
