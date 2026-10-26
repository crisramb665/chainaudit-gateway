-- =====================================================================
-- ChainAudit SQL lab
-- Run each block by hand in DBeaver against the local Postgres.
-- Read the "Expected" line BEFORE running, predict, then compare.
-- Exercises 3 and 4 need DBeaver in manual commit mode (not auto commit).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. Setup: isolated schema with the tables from the RFC
-- ---------------------------------------------------------------------
DROP SCHEMA IF EXISTS lab CASCADE;
CREATE SCHEMA lab;
SET search_path TO lab;

CREATE TABLE engagements (
  id          uuid PRIMARY KEY,
  tenant_id   text NOT NULL,
  client_name text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_engagements_tenant ON engagements (tenant_id);

CREATE TABLE chain_transactions (
  id            bigserial PRIMARY KEY,
  engagement_id uuid NOT NULL REFERENCES engagements(id),
  chain_id      int NOT NULL,
  tx_hash       text NOT NULL,
  log_index     int NOT NULL,
  block_number  bigint NOT NULL,
  block_hash    text NOT NULL,
  amount        numeric(78,0) NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','final','orphaned')),
  UNIQUE (engagement_id, chain_id, tx_hash, log_index)
);
CREATE INDEX idx_tx_recent  ON chain_transactions (engagement_id, block_number DESC);
CREATE INDEX idx_tx_pending ON chain_transactions (chain_id, block_number)
  WHERE status = 'pending';

CREATE TABLE ledger_entries (
  id            bigserial PRIMARY KEY,
  engagement_id uuid NOT NULL REFERENCES engagements(id),
  entry_ref     text NOT NULL,
  tx_hash       text,
  amount        numeric(78,0) NOT NULL,
  UNIQUE (engagement_id, entry_ref)
);
CREATE INDEX idx_ledger_tx ON ledger_entries (engagement_id, tx_hash);

CREATE TABLE reconciliation_jobs (
  id              uuid PRIMARY KEY,
  engagement_id   uuid NOT NULL REFERENCES engagements(id),
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'queued',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (engagement_id, idempotency_key)
);
CREATE INDEX idx_jobs_open ON reconciliation_jobs (created_at)
  WHERE status IN ('queued','running');

CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX idx_outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

-- One engagement with a fixed id, so every exercise can reference it.
INSERT INTO engagements (id, tenant_id, client_name)
VALUES ('11111111-1111-1111-1111-111111111111', 'acme', 'Demo client');


-- ---------------------------------------------------------------------
-- 1. Deduplication with ON CONFLICT
-- Concept: the unique constraint, not application code, decides
-- what a duplicate is. Safe under concurrency.
-- ---------------------------------------------------------------------

-- Run this twice.
-- Expected: first run "INSERT 0 1", second run "INSERT 0 0", no error.
INSERT INTO chain_transactions
  (engagement_id, chain_id, tx_hash, log_index, block_number, block_hash, amount)
VALUES
  ('11111111-1111-1111-1111-111111111111', 1, '0xaaa', 0, 100, '0xb100', 1000)
ON CONFLICT (engagement_id, chain_id, tx_hash, log_index) DO NOTHING;

-- Now without ON CONFLICT.
-- Expected: ERROR duplicate key value violates unique constraint.
INSERT INTO chain_transactions
  (engagement_id, chain_id, tx_hash, log_index, block_number, block_hash, amount)
VALUES
  ('11111111-1111-1111-1111-111111111111', 1, '0xaaa', 0, 100, '0xb100', 1000);

-- Question to answer out loud: why is "SELECT, and INSERT if not found"
-- wrong with two concurrent writers?


-- ---------------------------------------------------------------------
-- 2. Idempotent job creation plus outbox, in ONE statement
-- Concept: the job and its event are written atomically, and a retried
-- request with the same key returns the original job.
-- ---------------------------------------------------------------------

-- Run this three times.
-- Expected: first run returns (id, created); next runs return the SAME
-- id with "existing". The outbox gets exactly one row.
WITH new_job AS (
  INSERT INTO reconciliation_jobs (id, engagement_id, idempotency_key)
  VALUES (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'key-1')
  ON CONFLICT (engagement_id, idempotency_key) DO NOTHING
  RETURNING id
),
new_event AS (
  INSERT INTO outbox (event_type, payload)
  SELECT 'reconciliation.requested', jsonb_build_object('job_id', id)
  FROM new_job
  RETURNING id
)
SELECT id, 'created' AS result FROM new_job
UNION ALL
SELECT id, 'existing' FROM reconciliation_jobs
WHERE engagement_id = '11111111-1111-1111-1111-111111111111'
  AND idempotency_key = 'key-1'
  AND NOT EXISTS (SELECT 1 FROM new_job);

-- Expected: 1 row.
SELECT * FROM outbox;

-- Edge case to understand, not to run: if two requests with the same new
-- key arrive at the same time, the second one waits for the first to
-- commit, then does nothing, but its snapshot started before that commit,
-- so the final SELECT can return zero rows. The application must then
-- re-read the job in a new statement.


-- ---------------------------------------------------------------------
-- 3. Atomicity: all or nothing
-- Switch DBeaver to manual commit for this block.
-- ---------------------------------------------------------------------
BEGIN;

INSERT INTO reconciliation_jobs (id, engagement_id, idempotency_key)
VALUES (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'key-2');

-- Expected: ERROR, null value violates not null constraint on payload.
INSERT INTO outbox (event_type, payload)
VALUES ('reconciliation.requested', NULL);

-- After an error, Postgres refuses every statement until you end the
-- transaction. Expected: ROLLBACK even if you type COMMIT.
ROLLBACK;

-- Expected: 0 rows. The job was never persisted because its event failed.
SELECT * FROM reconciliation_jobs WHERE idempotency_key = 'key-2';


-- ---------------------------------------------------------------------
-- 4. Workers claiming jobs with SKIP LOCKED
-- Needs TWO DBeaver sessions (open a second SQL editor with its own
-- connection). Manual commit in both.
-- ---------------------------------------------------------------------

-- Setup, run once in any session and commit.
INSERT INTO reconciliation_jobs (id, engagement_id, idempotency_key)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'batch-' || g
FROM generate_series(1, 3) g;
COMMIT;

-- Session A:
BEGIN;
SELECT id, idempotency_key FROM reconciliation_jobs
WHERE status = 'queued'
ORDER BY created_at, idempotency_key
LIMIT 1
FOR UPDATE SKIP LOCKED;
-- leave it open, do not commit yet

-- Session B, same query.
-- Expected: a DIFFERENT job, returned immediately.
BEGIN;
SELECT id, idempotency_key FROM reconciliation_jobs
WHERE status = 'queued'
ORDER BY created_at, idempotency_key
LIMIT 1
FOR UPDATE SKIP LOCKED;
ROLLBACK;

-- Session B again, WITHOUT SKIP LOCKED.
-- Expected: it hangs until session A commits or rolls back.
BEGIN;
SELECT id, idempotency_key FROM reconciliation_jobs
WHERE status = 'queued'
ORDER BY created_at, idempotency_key
LIMIT 1
FOR UPDATE;
-- now go to session A and run ROLLBACK; session B continues.
ROLLBACK;

-- The real worker claims and marks in one statement.
-- Expected: one job moves to running; run it again to claim the next.
UPDATE reconciliation_jobs
SET status = 'running'
WHERE id IN (
  SELECT id FROM reconciliation_jobs
  WHERE status = 'queued'
  ORDER BY created_at, idempotency_key
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING id, idempotency_key, status;
COMMIT;


-- ---------------------------------------------------------------------
-- 5. Reconciliation joins
-- Data designed to produce every outcome:
--   0x01 matched, 0x02 amount mismatch, 0x03 missing in ledger,
--   0x04 missing on chain.
-- Switch back to auto commit if you like.
-- ---------------------------------------------------------------------
INSERT INTO chain_transactions
  (engagement_id, chain_id, tx_hash, log_index, block_number, block_hash, amount, status)
VALUES
  ('11111111-1111-1111-1111-111111111111', 1, '0x01', 0, 201, '0xb201', 100, 'final'),
  ('11111111-1111-1111-1111-111111111111', 1, '0x02', 0, 202, '0xb202', 200, 'final'),
  ('11111111-1111-1111-1111-111111111111', 1, '0x03', 0, 203, '0xb203', 300, 'final');

INSERT INTO ledger_entries (engagement_id, entry_ref, tx_hash, amount)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'L-1', '0x01', 100),
  ('11111111-1111-1111-1111-111111111111', 'L-2', '0x02', 250),
  ('11111111-1111-1111-1111-111111111111', 'L-4', '0x04', 400);

-- 5a. INNER JOIN. Expected: 2 rows (0x01, 0x02). Unmatched rows vanish.
SELECT c.tx_hash, c.amount AS chain_amount, l.amount AS ledger_amount
FROM chain_transactions c
JOIN ledger_entries l
  ON l.engagement_id = c.engagement_id AND l.tx_hash = c.tx_hash
WHERE c.engagement_id = '11111111-1111-1111-1111-111111111111'
  AND c.status = 'final';

-- 5b. LEFT JOIN. Expected: 3 rows; 0x03 appears with a null ledger side,
-- but 0x04 is still missing.
SELECT c.tx_hash, c.amount AS chain_amount, l.amount AS ledger_amount
FROM chain_transactions c
LEFT JOIN ledger_entries l
  ON l.engagement_id = c.engagement_id AND l.tx_hash = c.tx_hash
WHERE c.engagement_id = '11111111-1111-1111-1111-111111111111'
  AND c.status = 'final';

-- 5c. The RFC query: FULL OUTER JOIN with filters inside subqueries.
-- Expected: 4 rows, one per outcome.
SELECT
  COALESCE(c.tx_hash, l.tx_hash) AS tx_hash,
  c.amount AS chain_amount,
  l.amount AS ledger_amount,
  CASE
    WHEN l.id IS NULL THEN 'missing_in_ledger'
    WHEN c.id IS NULL THEN 'missing_on_chain'
    WHEN c.amount <> l.amount THEN 'amount_mismatch'
    ELSE 'matched'
  END AS result
FROM (SELECT * FROM chain_transactions
      WHERE engagement_id = '11111111-1111-1111-1111-111111111111'
        AND status = 'final') c
FULL OUTER JOIN (SELECT * FROM ledger_entries
                 WHERE engagement_id = '11111111-1111-1111-1111-111111111111') l
  ON l.tx_hash = c.tx_hash
ORDER BY 1;

-- 5d. The classic bug: same join, but the filter moved to WHERE.
-- Expected: 3 rows. 0x04 disappears, because for that row c.* is null
-- and "c.engagement_id = ..." is not true, so WHERE removes it.
-- The FULL OUTER JOIN silently became a LEFT JOIN.
SELECT
  COALESCE(c.tx_hash, l.tx_hash) AS tx_hash,
  c.amount AS chain_amount,
  l.amount AS ledger_amount
FROM chain_transactions c
FULL OUTER JOIN ledger_entries l
  ON l.engagement_id = c.engagement_id AND l.tx_hash = c.tx_hash
WHERE c.engagement_id = '11111111-1111-1111-1111-111111111111'
  AND c.status = 'final'
ORDER BY 1;


-- ---------------------------------------------------------------------
-- 6. Indexes: see them work with EXPLAIN ANALYZE
-- ---------------------------------------------------------------------

-- Load volume: 1,000 engagements and 200,000 transactions.
INSERT INTO engagements (id, tenant_id, client_name)
SELECT gen_random_uuid(), 'tenant-' || (g % 10), 'client ' || g
FROM generate_series(1, 1000) g;

INSERT INTO chain_transactions
  (engagement_id, chain_id, tx_hash, log_index, block_number, block_hash, amount, status)
SELECT e.id, 1, '0x' || md5(g::text), 0, 1000 + g, '0xb' || g,
       (random() * 1e18)::numeric(78,0),
       CASE WHEN g % 100 = 0 THEN 'pending' ELSE 'final' END
FROM generate_series(1, 200000) g
JOIN (SELECT id, row_number() OVER () AS rn FROM engagements) e
  ON e.rn = (g % 1000) + 1;

ANALYZE;

-- 6a. "Latest 20 transactions of one engagement".
-- Expected: Index Scan using idx_tx_recent, no Sort node.
EXPLAIN ANALYZE
SELECT * FROM chain_transactions
WHERE engagement_id = (SELECT id FROM engagements WHERE client_name = 'client 500')
ORDER BY block_number DESC
LIMIT 20;

-- 6b. Drop that index and run 6a again.
-- Expected: Postgres still finds the rows through the UNIQUE index
-- (its first column is also engagement_id), but now a Sort node appears,
-- because that index is not ordered by block_number.
-- Lesson: column ORDER in a composite index decides what it can do.
DROP INDEX idx_tx_recent;

-- 6c. Put it back.
CREATE INDEX idx_tx_recent ON chain_transactions (engagement_id, block_number DESC);

-- 6d. Partial index for the finality worker.
-- Expected: Index Scan using idx_tx_pending.
EXPLAIN ANALYZE
SELECT id, tx_hash FROM chain_transactions
WHERE status = 'pending' AND chain_id = 1
ORDER BY block_number
LIMIT 100;

-- 6e. Why partial: compare sizes.
-- Expected: idx_tx_pending is a small fraction of idx_tx_recent,
-- because it only holds the 1% of rows that are pending.
SELECT
  pg_size_pretty(pg_relation_size('idx_tx_pending')) AS partial_pending,
  pg_size_pretty(pg_relation_size('idx_tx_recent'))  AS full_recent;


-- ---------------------------------------------------------------------
-- Cleanup when done
-- ---------------------------------------------------------------------
-- DROP SCHEMA lab CASCADE;