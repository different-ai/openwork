ALTER TABLE artifact_view ADD COLUMN data_mode enum('live','snapshot') NOT NULL DEFAULT 'snapshot';
