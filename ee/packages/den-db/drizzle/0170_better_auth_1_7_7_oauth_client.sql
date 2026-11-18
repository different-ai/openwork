ALTER TABLE `oauthClient` ADD `client_discovery_id` varchar(64);--> statement-breakpoint
ALTER TABLE `oauthClient` ADD `client_credentials_scopes` text;--> statement-breakpoint
ALTER TABLE `oauthClient` ADD `application_type` varchar(32);--> statement-breakpoint
-- Clients registered from a Client ID Metadata Document use their https URL as client_id; dynamic registrations never do. Better Auth 1.7.7 rejects such clients unless they are marked as owned by the "cimd" discovery.
UPDATE `oauthClient` SET `client_discovery_id` = 'cimd' WHERE `client_id` LIKE 'https://%' AND `client_discovery_id` IS NULL;
