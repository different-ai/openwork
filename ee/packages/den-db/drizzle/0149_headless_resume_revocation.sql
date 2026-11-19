CREATE TABLE `headless_resume_revocation` (
	`organization_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`revoked_at` timestamp(3) NOT NULL,
	CONSTRAINT `headless_resume_revocation_organization_id_user_id_pk` PRIMARY KEY(`organization_id`,`user_id`)
);
