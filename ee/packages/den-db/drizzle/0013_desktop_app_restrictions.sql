ALTER TABLE `organization`
ADD COLUMN `desktop_app_restrictions` json NOT NULL DEFAULT (json_object());
