# Support triage

Platform admins can turn on support triage in **Admin → Support triage**. Triage starts off and requires the deployment's existing Jev configuration and a dedicated Plain API key. Create the key in the Plain workspace that receives the inbox, with access to those threads and the following permissions:

| Permission | Used for |
| --- | --- |
| `workspace:read` | Find the Plain workspace the key belongs to (also used by **Test connection**). |
| `thread:read` | List new threads and verify current thread status and priority. |
| `timeline:read` | Read the first inbound message of a thread. |
| `customer:read` | Read the sender's email domain. |
| `labelType:read`, `labelType:create` | Look up and provision the four triage label types. |
| `label:read`, `label:create` | Check a thread's labels and apply the selected label. |
| `thread:setPriority` | Change a thread's priority. |
| `thread:setStatus` | Mark a thread Done. |

**Test connection** verifies the key reaches its Plain workspace. It doesn't exercise write permissions. Optionally add Slack incoming webhooks and send a test message to each to check its destination, then turn on triage:

- **Bugs Slack webhook** receives product bugs.
- **Leads Slack webhook** receives enterprise leads. When it isn't set, enterprise leads go to the bugs webhook instead.

| Result | Action |
| --- | --- |
| Product bug | Label Product bug, set priority to High, and notify the bugs Slack webhook if configured. |
| Enterprise lead | Label Enterprise lead, set priority to Urgent, and notify the leads Slack webhook (or the bugs webhook when no leads webhook is set) if configured. |
| Job ask or pitch | Apply the matching label and mark the thread Done. |
| Needs review or Other | Leave the thread unchanged. Filter the list to Needs review to find unclear threads. |

Only threads created since the latest enable time are considered. Turning triage off doesn't undo changes already made in Plain. Clearing the Plain key also turns triage off. The worker doesn't send replies or mark customers as spam.

Jev receives the title, up to 4,000 characters from the first inbound message, and the sender's domain (not the email address). Den keeps the thread title, short preview, and model probabilities encrypted; it doesn't store the full message body. Slack alerts for bugs and enterprise leads include the title, domain, and links, not the message body. A failed row stays visible in Den for manual review; if Slack delivery is uncertain, check the destination before posting manually.
