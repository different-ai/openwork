ALTER TABLE `llm_provider`
  ADD COLUMN `credential_kind` enum('api_key','opencode_oauth') NOT NULL DEFAULT 'api_key' AFTER `provider_config`,
  ADD COLUMN `opencode_auth` text AFTER `api_key`;
