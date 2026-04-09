CREATE TABLE `rate_limit` (
	`id` varchar(255) NOT NULL,
	`key` varchar(512) NOT NULL,
	`count` int NOT NULL DEFAULT 0,
	`last_request` bigint NOT NULL,
	CONSTRAINT `rate_limit_id` PRIMARY KEY(`id`),
	CONSTRAINT `rate_limit_key` UNIQUE(`key`)
);
