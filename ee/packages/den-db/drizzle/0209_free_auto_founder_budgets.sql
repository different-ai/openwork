CREATE TABLE `free_auto_org_founder` (
	`organization_id` varchar(64) NOT NULL,
	`founder_user_id` varchar(64) NOT NULL,
	CONSTRAINT `free_auto_org_founder_organization_id` PRIMARY KEY(`organization_id`)
);
--> statement-breakpoint
ALTER TABLE `inference_free_usage` ADD `desktop_hash` varchar(64);--> statement-breakpoint
CREATE INDEX `free_auto_org_founder_user` ON `free_auto_org_founder` (`founder_user_id`);--> statement-breakpoint
CREATE INDEX `inference_free_usage_desktop_created` ON `inference_free_usage` (`desktop_hash`,`created_at`);
--> statement-breakpoint
INSERT INTO free_auto_org_founder (organization_id, founder_user_id)
SELECT ranked.organization_id, ranked.user_id FROM (
  SELECT organization_id, user_id, joined_at, invite_id, invited_by_org_member,
         ROW_NUMBER() OVER (PARTITION BY organization_id ORDER BY created_at, id) AS position_in_org
  FROM member
  WHERE is_setup_agent = false AND NOT EXISTS (
    SELECT 1 FROM workspace_bootstrap WHERE workspace_bootstrap.organization_id = member.organization_id
  )
) AS ranked
WHERE ranked.position_in_org = 1 AND ranked.user_id IS NOT NULL AND ranked.joined_at IS NOT NULL
  AND ranked.invite_id IS NULL AND ranked.invited_by_org_member IS NULL
ON DUPLICATE KEY UPDATE founder_user_id = free_auto_org_founder.founder_user_id;
--> statement-breakpoint
INSERT INTO free_auto_org_founder (organization_id, founder_user_id)
SELECT ranked.organization_id, ranked.claimed_by_user_id FROM (
  SELECT claims.*, ROW_NUMBER() OVER (PARTITION BY organization_id ORDER BY claimed_at, id) AS position_in_org
  FROM (
    SELECT id, organization_id, claimed_by_user_id, claimed_at FROM workspace_claim
    WHERE role = 'owner' AND status = 'claimed' AND claimed_by_user_id IS NOT NULL AND claimed_at IS NOT NULL
    UNION ALL
    SELECT id, organization_id, claimed_by_user_id, accepted_at AS claimed_at FROM workspace_claim_code
    WHERE state IN ('accepted', 'reconciled') AND claimed_by_user_id IS NOT NULL AND accepted_at IS NOT NULL
  ) AS claims
) AS ranked WHERE ranked.position_in_org = 1
ON DUPLICATE KEY UPDATE founder_user_id = free_auto_org_founder.founder_user_id;
