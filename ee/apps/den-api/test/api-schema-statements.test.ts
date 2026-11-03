import assert from "node:assert/strict"
import test from "node:test"
import { inlineIndexes } from "./api/schema-statements.js"

test("API test schemas fold each index into its table's CREATE TABLE", () => {
  const folded = inlineIndexes([
    "CREATE TABLE `member` (\n\t`id` varchar(64) NOT NULL,\n\t`user_id` varchar(64) NOT NULL,\n\tCONSTRAINT `member_id` PRIMARY KEY(`id`)\n)",
    "CREATE TABLE `team` (\n\t`id` varchar(64) NOT NULL\n)",
    "CREATE INDEX `member_user_id` ON `member` (`user_id`)",
    "CREATE UNIQUE INDEX `member_user_unique` ON `member` (`user_id`,`id`)",
  ])
  assert.deepEqual(folded, [
    "CREATE TABLE `member` (\n\t`id` varchar(64) NOT NULL,\n\t`user_id` varchar(64) NOT NULL,\n\tCONSTRAINT `member_id` PRIMARY KEY(`id`),\n\tINDEX `member_user_id` (`user_id`),\n\tUNIQUE INDEX `member_user_unique` (`user_id`,`id`)\n)",
    "CREATE TABLE `team` (\n\t`id` varchar(64) NOT NULL\n)",
  ])
})

test("API test schemas keep statements they cannot fold, after every table", () => {
  const folded = inlineIndexes([
    "CREATE INDEX `orphan_idx` ON `missing` (`id`)",
    "ALTER TABLE `team` ADD CONSTRAINT `team_fk` FOREIGN KEY (`id`) REFERENCES `member`(`id`)",
    "CREATE TABLE `team` (\n\t`id` varchar(64) NOT NULL\n) ENGINE=InnoDB",
    "CREATE INDEX `team_id` ON `team` (`id`)",
  ])
  assert.deepEqual(folded, [
    "CREATE TABLE `team` (\n\t`id` varchar(64) NOT NULL\n) ENGINE=InnoDB",
    "CREATE INDEX `orphan_idx` ON `missing` (`id`)",
    "ALTER TABLE `team` ADD CONSTRAINT `team_fk` FOREIGN KEY (`id`) REFERENCES `member`(`id`)",
    "CREATE INDEX `team_id` ON `team` (`id`)",
  ])
})
