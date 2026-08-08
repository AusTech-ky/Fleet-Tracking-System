-- 003: refresh tokens.
--
-- Enables short-lived access tokens with a rotating, revocable refresh token.
-- Tokens are stored hashed (SHA-256) — a database leak must not yield usable
-- credentials. `family_id` links every token descended from one login so that
-- reuse of an already-exchanged token can revoke the whole chain.

CREATE TABLE IF NOT EXISTS refresh_token (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  family_id   uuid NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refresh_token_family_idx ON refresh_token (family_id);
CREATE INDEX IF NOT EXISTS refresh_token_user_idx ON refresh_token (user_id);
-- Housekeeping: expired rows can be pruned periodically, e.g.
--   DELETE FROM refresh_token WHERE expires_at < now() - interval '30 days';
