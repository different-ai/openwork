UPDATE `user` SET `email` = lower(trim(`email`)) WHERE `email` <> lower(trim(`email`));--> statement-breakpoint
CREATE INDEX `account_account_id_provider_id` ON `account` (`account_id`(191),`provider_id`(191));--> statement-breakpoint
CREATE INDEX `oauth_refresh_token_token` ON `oauthRefreshToken` (`token`(191));--> statement-breakpoint
CREATE INDEX `inference_org_limit_policies_current_bucket_id` ON `inference_org_limit_policies` (`current_bucket_id`);--> statement-breakpoint
CREATE INDEX `worker_claimable_updated` ON `worker` (`destination`,`sandbox_backend`,`status`,`updated_at`);
