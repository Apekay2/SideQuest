-- migrations/0005_currency.sql
-- Adds the currency and market dimensions. Runs while the ledger is small; the same
-- migration against a populated multi-market ledger is a backfill nobody can verify,
-- because there is no way to recover which currency a bare integer was in.
--
-- Decision (10-panel-review.md §10.6.1, confirmed with the product owner): the minor-unit
-- exponent stays at 2 for now. The COLUMN exists so that is a fact about the data rather
-- than an assumption in code; `money_currency` carries the exponent alongside each code so
-- a report or a rail adapter never has to guess.
--
-- Backfill is safe here and only here: every existing row is KES by construction, because
-- there has never been another market.

BEGIN;

-- ─────────────────────────────────────────────── reference tables

CREATE TABLE money_currency (
  code        char(3) PRIMARY KEY,
  exponent    smallint NOT NULL CHECK (exponent IN (0, 2, 3)),
  symbol      text NOT NULL,
  numeric_code char(3) NOT NULL,
  -- Enabled means "the application code is proven against this exponent", not "we operate
  -- here". Mirrors SUPPORTED in currency.ts; the boot check asserts they agree.
  enabled     boolean NOT NULL DEFAULT false
);

INSERT INTO money_currency (code, exponent, symbol, numeric_code, enabled) VALUES
  ('KES', 2, 'KSh',  '404', true),
  ('UGX', 0, 'USh',  '800', false),
  ('TZS', 0, 'TSh',  '834', false),
  ('RWF', 0, 'FRw',  '646', false),
  ('NGN', 2, '₦',    '566', false),
  ('ZAR', 2, 'R',    '710', false),
  ('GHS', 2, 'GH₵',  '936', false),
  ('USD', 2, '$',    '840', false),
  ('EUR', 2, '€',    '978', false),
  ('GBP', 2, '£',    '826', false);

CREATE TABLE market (
  country         char(2) PRIMARY KEY,
  currency        char(3) NOT NULL REFERENCES money_currency (code),
  dial_code       text NOT NULL,
  timezone        text NOT NULL,
  emergency_number text NOT NULL,
  min_payout_minor bigint NOT NULL CHECK (min_payout_minor > 0),
  fee_rate_bps    int NOT NULL CHECK (fee_rate_bps BETWEEN 0 AND 3000),
  chargeback_window_days int NOT NULL DEFAULT 0,
  region          text NOT NULL,
  work_direction  text NOT NULL CHECK (work_direction IN ('runner_chooses','platform_offers','platform_assigns')),
  enabled         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO market (country, currency, dial_code, timezone, emergency_number,
                    min_payout_minor, fee_rate_bps, chargeback_window_days, region,
                    work_direction, enabled)
VALUES ('KE', 'KES', '254', 'Africa/Nairobi', '999', 10000, 1200, 0, 'af-south-1',
        'runner_chooses', true);

-- A market may not be enabled unless its currency is. This is the constraint that stops a
-- zero-decimal market being switched on before the exponent work is done.
CREATE OR REPLACE FUNCTION assert_market_currency_enabled() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enabled AND NOT EXISTS (
    SELECT 1 FROM money_currency WHERE code = NEW.currency AND enabled
  ) THEN
    RAISE EXCEPTION 'Cannot enable market % : currency % is not enabled', NEW.country, NEW.currency;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER market_currency_gate BEFORE INSERT OR UPDATE ON market
  FOR EACH ROW EXECUTE FUNCTION assert_market_currency_enabled();

-- ─────────────────────────────────────────────── dimensions on existing tables

ALTER TABLE account         ADD COLUMN market char(2) NOT NULL DEFAULT 'KE' REFERENCES market (country);
ALTER TABLE errand          ADD COLUMN market char(2) NOT NULL DEFAULT 'KE' REFERENCES market (country);
ALTER TABLE errand          ADD COLUMN currency char(3) NOT NULL DEFAULT 'KES' REFERENCES money_currency (code);
ALTER TABLE errand_fee      ADD COLUMN currency char(3) NOT NULL DEFAULT 'KES' REFERENCES money_currency (code);
ALTER TABLE escrow          ADD COLUMN currency char(3) NOT NULL DEFAULT 'KES' REFERENCES money_currency (code);
ALTER TABLE card            ADD COLUMN currency char(3) NOT NULL DEFAULT 'KES' REFERENCES money_currency (code);
ALTER TABLE tranche         ADD COLUMN currency char(3) NOT NULL DEFAULT 'KES' REFERENCES money_currency (code);
ALTER TABLE payment         ADD COLUMN currency char(3) NOT NULL DEFAULT 'KES' REFERENCES money_currency (code);
ALTER TABLE payout          ADD COLUMN currency char(3) NOT NULL DEFAULT 'KES' REFERENCES money_currency (code);
ALTER TABLE stall           ADD COLUMN currency char(3) NOT NULL DEFAULT 'KES' REFERENCES money_currency (code);
ALTER TABLE posting         ADD COLUMN currency char(3) NOT NULL DEFAULT 'KES' REFERENCES money_currency (code);
ALTER TABLE posting_group   ADD COLUMN currency char(3) NOT NULL DEFAULT 'KES' REFERENCES money_currency (code);

-- Drop the defaults once backfilled: a default is right for this migration and wrong
-- afterwards, because it lets a second-market insert silently record KES.
ALTER TABLE errand        ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE errand_fee    ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE escrow        ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE card          ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE tranche       ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE payment       ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE payout        ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE stall         ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE posting       ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE posting_group ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE errand        ALTER COLUMN market   DROP DEFAULT;

-- ─────────────────────────────────────────────── single-currency invariants

-- A posting group is single-currency. A cross-currency "sums to zero" check is meaningless,
-- so this constraint is what keeps the balance trigger and the nightly reconciliation
-- interpretable. FX is an explicit conversion group: two single-currency groups linked by
-- an fx_conversion row, never one mixed group.
CREATE OR REPLACE FUNCTION assert_group_single_currency() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE n int; g char(3);
BEGIN
  SELECT count(DISTINCT currency), min(currency) INTO n, g
    FROM posting WHERE group_id = NEW.group_id;
  IF n > 1 THEN
    RAISE EXCEPTION 'Posting group % mixes currencies', NEW.group_id;
  END IF;
  IF EXISTS (SELECT 1 FROM posting_group pg WHERE pg.id = NEW.group_id AND pg.currency <> g) THEN
    RAISE EXCEPTION 'Posting group % currency does not match its postings', NEW.group_id;
  END IF;
  RETURN NULL;
END $$;

-- Deferred, like the existing balance trigger, so a group can be inserted posting by
-- posting inside one transaction.
CREATE CONSTRAINT TRIGGER posting_single_currency
  AFTER INSERT ON posting
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_group_single_currency();

-- An errand's money rows all match the errand's currency. Cheap to assert, and it catches
-- the class of bug where a fee is computed in the requester's currency and an escrow in the
-- market's.
CREATE OR REPLACE FUNCTION assert_errand_currency() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE want char(3);
BEGIN
  SELECT currency INTO want FROM errand WHERE id = NEW.errand_id;
  IF want IS NOT NULL AND NEW.currency <> want THEN
    RAISE EXCEPTION '% row currency % does not match errand currency %', TG_TABLE_NAME, NEW.currency, want;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER escrow_currency     BEFORE INSERT OR UPDATE ON escrow     FOR EACH ROW EXECUTE FUNCTION assert_errand_currency();
CREATE TRIGGER errand_fee_currency BEFORE INSERT OR UPDATE ON errand_fee FOR EACH ROW EXECUTE FUNCTION assert_errand_currency();
CREATE TRIGGER card_currency       BEFORE INSERT OR UPDATE ON card       FOR EACH ROW EXECUTE FUNCTION assert_errand_currency();
CREATE TRIGGER stall_currency      BEFORE INSERT OR UPDATE ON stall      FOR EACH ROW EXECUTE FUNCTION assert_errand_currency();

-- ─────────────────────────────────────────────── FX, modelled but unused

-- Recorded explicitly when it first happens, with the rate and its source, because a rate
-- reconstructed after the fact is not auditable. No rows until a second currency exists.
CREATE TABLE fx_conversion (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_group_id uuid NOT NULL REFERENCES posting_group (id),
  to_group_id   uuid NOT NULL REFERENCES posting_group (id),
  from_currency char(3) NOT NULL REFERENCES money_currency (code),
  to_currency   char(3) NOT NULL REFERENCES money_currency (code),
  from_minor    bigint NOT NULL CHECK (from_minor > 0),
  to_minor      bigint NOT NULL CHECK (to_minor > 0),
  rate_numerator   bigint NOT NULL CHECK (rate_numerator > 0),
  rate_denominator bigint NOT NULL CHECK (rate_denominator > 0),
  rate_source   text NOT NULL,
  rate_at       timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (from_currency <> to_currency)
);

-- Client money must be distinguishable from platform money before the platform holds any,
-- because every licensing regime asks for it and no regime accepts a reconstruction
-- (10-panel-review.md §10.6.3).
ALTER TABLE posting ADD COLUMN fund_class text NOT NULL DEFAULT 'client'
  CHECK (fund_class IN ('client', 'platform'));
UPDATE posting SET fund_class = 'platform' WHERE account IN ('platform_fee', 'platform_cash');
ALTER TABLE posting ALTER COLUMN fund_class DROP DEFAULT;

CREATE INDEX posting_currency_account_idx ON posting (currency, account, owner_id);
CREATE INDEX errand_market_idx ON errand (market, created_at DESC);

COMMIT;

-- ─────────────────────────────────────────────── verification
-- Any row returned is a failure.
--
--   -- postings whose currency disagrees with their group
--   SELECT p.group_id FROM posting p JOIN posting_group g ON g.id = p.group_id
--    WHERE p.currency <> g.currency;
--
--   -- enabled markets on a disabled currency
--   SELECT m.country FROM market m JOIN money_currency c ON c.code = m.currency
--    WHERE m.enabled AND NOT c.enabled;
--
--   -- balance must be asserted PER CURRENCY, never across
--   SELECT currency, sum(amount_minor) FROM posting GROUP BY currency HAVING sum(amount_minor) <> 0;
