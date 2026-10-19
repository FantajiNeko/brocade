BEGIN;

ALTER TABLE ingresses
    ADD COLUMN IF NOT EXISTS guard_cn_source_block TEXT;

UPDATE ingresses
SET guard_cn_source_block = 'off'
WHERE guard_cn_source_block IS NULL;

ALTER TABLE ingresses
    ALTER COLUMN guard_cn_source_block SET DEFAULT 'off',
    ALTER COLUMN guard_cn_source_block SET NOT NULL;

ALTER TABLE ingresses
    DROP CONSTRAINT IF EXISTS ingresses_guard_cn_source_block_known;

ALTER TABLE ingresses
    ADD CONSTRAINT ingresses_guard_cn_source_block_known CHECK (
        guard_cn_source_block IN ('off', 'ipv4', 'ipv4-and-ipv6')
    );

COMMIT;
