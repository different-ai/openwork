ALTER TABLE `org_subscriptions` MODIFY COLUMN `type` enum('inference','seat','web','enterprise') NOT NULL;--> statement-breakpoint
ALTER TABLE `org_subscriptions` ADD `minimum_quantity` int DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Record the Team plan for organizations paying for it, the same rule
-- stripe-billing.ts applies on every Stripe event (PR #6364). Production was
-- backfilled by hand; this brings staging and other environments in line.
-- Idempotent, and it never touches admin-set (manual), grandfathered or
-- Enterprise plans.
UPDATE `organization` `o`
SET `o`.`metadata` = JSON_SET(
  COALESCE(`o`.`metadata`, JSON_OBJECT()),
  '$.plan',
  JSON_MERGE_PATCH(
    COALESCE(JSON_EXTRACT(`o`.`metadata`, '$.plan'), JSON_OBJECT()),
    JSON_OBJECT('tier', 'team', 'source', 'stripe')
  )
)
WHERE COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`o`.`metadata`, '$.plan.tier')), 'free') <> 'enterprise'
  AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`o`.`metadata`, '$.plan.source')), 'default') NOT IN ('manual', 'grandfathered')
  AND NOT (
    COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`o`.`metadata`, '$.plan.tier')), 'free') = 'team'
    AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`o`.`metadata`, '$.plan.source')), 'default') = 'stripe'
  )
  AND EXISTS (
    SELECT 1 FROM `org_subscriptions` `s`
    WHERE `s`.`organization_id` = `o`.`id`
      AND `s`.`type` = 'seat'
      AND `s`.`status` IN ('active', 'trialing', 'past_due')
  );
