ALTER TABLE `gateway_usage_limit_assignment`
  ADD `organization` boolean,
  DROP CONSTRAINT `gateway_usage_assignment_target`,
  ADD CONSTRAINT `gateway_usage_assignment_organization` UNIQUE(`organization_id`,`policy_id`,`organization`),
  ADD CONSTRAINT `gateway_usage_assignment_target` CHECK ((`gateway_usage_limit_assignment`.`organization` is null and ((`gateway_usage_limit_assignment`.`member_id` is null) <> (`gateway_usage_limit_assignment`.`team_id` is null))) or (`gateway_usage_limit_assignment`.`organization` is not null and `gateway_usage_limit_assignment`.`organization` = 1 and `gateway_usage_limit_assignment`.`member_id` is null and `gateway_usage_limit_assignment`.`team_id` is null));
