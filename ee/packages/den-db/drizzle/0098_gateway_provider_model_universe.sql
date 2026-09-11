-- Keep existing providers restricted to their materialized selection before
-- installing the allow-all default for newly created providers.
ALTER TABLE `gateway_providers` ADD `model_ids` json NULL;
--> statement-breakpoint
UPDATE `gateway_providers` AS provider
LEFT JOIN (
  SELECT `gateway_provider_id`, JSON_ARRAYAGG(`model_id`) AS `model_ids`
  FROM `gateway_provider_models`
  GROUP BY `gateway_provider_id`
) AS selected_models ON selected_models.`gateway_provider_id` = provider.`id`
SET provider.`model_ids` = COALESCE(selected_models.`model_ids`, JSON_ARRAY())
WHERE provider.`model_ids` IS NULL;
--> statement-breakpoint
ALTER TABLE `gateway_providers` MODIFY COLUMN `model_ids` json NOT NULL DEFAULT (JSON_ARRAY());
