UPDATE `organization`
SET `metadata` = '{}'
WHERE `metadata` IS NULL
   OR TRIM(`metadata`) = ''
   OR JSON_VALID(`metadata`) = 0;

ALTER TABLE `organization`
  MODIFY COLUMN `metadata` json NULL;

UPDATE `organization`
SET `metadata` = JSON_SET(
  `metadata`,
  '$.limits.members',
  COALESCE(
    NULLIF(CAST(JSON_UNQUOTE(JSON_EXTRACT(`metadata`, '$.limits.members')) AS SIGNED), 0),
    5
  ),
  '$.limits.workers',
  COALESCE(
    NULLIF(CAST(JSON_UNQUOTE(COALESCE(JSON_EXTRACT(`metadata`, '$.limits.workers'), JSON_EXTRACT(`metadata`, '$.limits.Workers'))) AS SIGNED), 0),
    1
  )
);

UPDATE `organization`
SET `metadata` = JSON_REMOVE(`metadata`, '$.limits.Workers')
WHERE JSON_EXTRACT(`metadata`, '$.limits.Workers') IS NOT NULL;
