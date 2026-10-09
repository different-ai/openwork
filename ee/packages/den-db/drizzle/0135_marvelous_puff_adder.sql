ALTER TABLE `aws_deployment_run` ADD `template_url` varchar(2048) NOT NULL;--> statement-breakpoint
ALTER TABLE `aws_deployment_run` ADD `bundle_url` varchar(2048) NOT NULL;--> statement-breakpoint
ALTER TABLE `aws_deployment_run` ADD `bundle_sha256` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `aws_deployment_run` ADD `api_origin` varchar(512) NOT NULL;