-- Persist control-plane deployment wave entry times on an existing Console database.
-- Stop old Console writers first, then run as the application role:
--   psql -X -v ON_ERROR_STOP=1 -d brocade -v app_role=brocade \
--     -f scripts/compat-deployment-wave-progress.sql
--
-- Deliberately omit IF NOT EXISTS. A repeated or partially applied conversion must stop so an
-- operator inspects the schema instead of silently accepting an unknown state. Historical first
-- waves use deployment creation, confirmed waves use their confirmation, and only old automatic
-- waves without a control-plane event fall back to their earliest recorded Agent claim.

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE :"app_role";

CREATE TABLE deployment_wave_progress (
    deployment_id BIGINT NOT NULL,
    wave INTEGER NOT NULL,
    entered_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT deployment_wave_progress_wave_check CHECK ((wave >= 0)),
    CONSTRAINT deployment_wave_progress_pkey PRIMARY KEY (deployment_id, wave),
    CONSTRAINT deployment_wave_progress_deployment_id_fkey
        FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
);

WITH waves AS (
    SELECT d.id AS deployment_id,
           d.created_at,
           d.started_at,
           dts.wave,
           min(dts.dispatched_at) AS first_dispatched_at,
           confirmation.confirmed_at
      FROM deployments d
      JOIN deployment_targets target ON target.deployment_id = d.id
      JOIN deployment_target_state dts
        ON dts.deployment_id = target.deployment_id
       AND dts.node_id = target.node_id
      LEFT JOIN deployment_wave_confirmations confirmation
        ON confirmation.deployment_id = d.id
       AND confirmation.wave = dts.wave
     WHERE target.status <> 'skipped'
     GROUP BY d.id, d.created_at, d.started_at, dts.wave, confirmation.confirmed_at
), timed AS (
    SELECT deployment_id,
           wave,
           CASE
             WHEN wave = min(wave) OVER (PARTITION BY deployment_id) THEN created_at
             WHEN confirmed_at IS NOT NULL THEN confirmed_at
             ELSE first_dispatched_at
           END AS entered_at
      FROM waves
)
INSERT INTO deployment_wave_progress (deployment_id, wave, entered_at)
SELECT deployment_id, wave, entered_at
  FROM timed
 WHERE entered_at IS NOT NULL;

UPDATE deployments deployment
   SET started_at = first_wave.entered_at
  FROM (
      SELECT DISTINCT ON (deployment_id) deployment_id, entered_at
        FROM deployment_wave_progress
       ORDER BY deployment_id, wave
  ) first_wave
 WHERE first_wave.deployment_id = deployment.id
   AND deployment.started_at IS DISTINCT FROM first_wave.entered_at;

COMMIT;
