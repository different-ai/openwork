"""One idempotent ECS task; only a terminal container exit can permit rollout."""
import hashlib
import json
import time


def run(event, ecs, remaining, pause=time.sleep):
    token = hashlib.sha256(json.dumps(event, sort_keys=True).encode()).hexdigest()
    response = ecs.run_task(
        cluster=event["cluster"], taskDefinition=event["taskDefinition"],
        launchType="FARGATE", count=1, clientToken=token,
        startedBy="openwork-migration",
        networkConfiguration=event["networkConfiguration"],
    )
    tasks = response.get("tasks", [])
    if response.get("failures") or len(tasks) != 1:
        return {"exitCode": -1, "reason": "RunTask rejected", "image": event["image"]}
    arn = tasks[0]["taskArn"]
    while remaining() > 30000:
        result = ecs.describe_tasks(cluster=event["cluster"], tasks=[arn])
        # ECS is eventually consistent immediately after RunTask.
        current = result.get("tasks", [])
        if current and current[0].get("lastStatus") == "STOPPED":
            containers = current[0].get("containers", [])
            success = len(containers) == 1 and containers[0].get("exitCode") == 0
            return {"taskArn": arn, "exitCode": 0 if success else -1, "image": event["image"]}
        pause(5)
    # Do not leave an unobserved migration running or retry ambiguous SQL work.
    ecs.stop_task(cluster=event["cluster"], task=arn, reason="Migration observation deadline exceeded")
    return {"taskArn": arn, "exitCode": -1, "reason": "Deadline exceeded; inspect task before retry", "image": event["image"]}


def handler(event, context):
    import boto3
    from botocore.config import Config
    # No SDK-level retry of an unknown migration outcome.
    ecs = boto3.client("ecs", config=Config(retries={"max_attempts": 0}, read_timeout=20, connect_timeout=10))
    return run(event, ecs, context.get_remaining_time_in_millis)
