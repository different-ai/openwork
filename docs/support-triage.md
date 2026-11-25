# Support triage

Platform admins can turn on support triage in **Admin → Support triage**. Triage starts off and requires the deployment's existing Jev configuration and a dedicated Plain API key. Create the key in the Plain workspace that receives the inbox, with access to those threads and the following permissions:

| Permission | Used for |
| --- | --- |
| `thread:read` | List new threads, read the first message, and verify current thread status and priority. |
| `customer:read` | Read the sender's email domain. |
| `labelType:read`, `labelType:create` | Look up and provision the four triage label types. |
| `label:create` | Apply the selected label to a thread. |
| `thread:edit` | Change a thread's priority or mark it Done. |

**Test connection** verifies the key reaches its Plain workspace. It doesn't exercise write permissions. Optionally add a Slack incoming webhook and send a test message to check its destination, then turn on triage.

| Result | Action |
| --- | --- |
| Product bug | Label Product bug, set priority to High, and notify Slack if configured. |
| Enterprise lead | Label Enterprise lead, set priority to Urgent, and notify Slack if configured. |
| Job ask or pitch | Apply the matching label and mark the thread Done. |
| Needs review or Other | Leave the thread unchanged. Filter the list to Needs review to find unclear threads. |

Only threads created since the latest enable time are considered. Turning triage off doesn't undo changes already made in Plain. Clearing the Plain key also turns triage off. The worker doesn't send replies or mark customers as spam.

Jev receives the title, up to 4,000 characters from the first inbound message, and the sender's domain (not the email address). Den keeps the thread title, short preview, and model probabilities encrypted; it doesn't store the full message body. Slack alerts for bugs and enterprise leads include the title, domain, and links, not the message body. A failed row stays visible in Den for manual review; if Slack delivery is uncertain, check the destination before posting manually.
