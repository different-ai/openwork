# Read Teams meeting transcripts

`teamsMeetingTranscripts` is off by default on cloud and self-hosted deployments. Owner: `benjaminshafii`.

## What changes

The Microsoft 365 connector gains one opt-in permission, **Read Teams meeting transcripts** (`teamsTranscriptRead`), under Teams in **What your AI can do**. It requests two delegated Microsoft Graph scopes: `OnlineMeetings.Read` and `OnlineMeetingTranscript.Read.All`. It is not a default permission, so existing connectors request nothing new.

With the feature on, the connector's Teams permissions show the new choice:

![The Teams permissions of the Microsoft 365 connector with Read Teams meeting transcripts selected](permission-on.png)

With the feature off, the choice is not offered:

![The Teams permissions of the Microsoft 365 connector without the transcript choice](permission-off.png)

With the permission on, agents get three read-only tools, each acting as the calling member:

| Tool | Graph call | Returns |
| --- | --- | --- |
| `findMicrosoft365TeamsMeeting` | `GET /me/onlineMeetings?$filter=JoinWebUrl eq '…'` | The meeting behind a Teams join link, or `null` |
| `listMicrosoft365TeamsMeetingTranscripts` | `GET /me/onlineMeetings/{id}/transcripts` | Transcript ids and times, no text |
| `readMicrosoft365TeamsMeetingTranscript` | `GET /me/onlineMeetings/{id}/transcripts/{id}/content` | One page of WebVTT with cue times and speaker names |

The usual path is: list calendar events, take the event's `onlineMeetingUrl`, find the meeting, list its transcripts, read the one for the right date. Every occurrence of a recurring meeting shares one meeting id, so the agent matches a transcript's `createdDateTime` to the occurrence.

The join link is checked to be an `https` Teams link and is only sent to Microsoft Graph as a filter value. Den never opens it. Transcript text is returned to the caller and not stored, logged, or kept as audit evidence. Long transcripts come back in pages of at most 18,000 characters (`pageToken`, `nextPageToken`) that end on a whole cue, so a page is never cut by the 20,000-character limit on tool results.

## How to try it

1. Turn `teamsMeetingTranscripts` on for a test organization in `/admin`.
2. In the organization's Microsoft 365 connector, tick **Read Teams meeting transcripts** and save.
3. In the Entra app registration, add the delegated permissions `OnlineMeetings.Read` and `OnlineMeetingTranscript.Read.All`. An Entra administrator grants admin consent: Microsoft requires it for `OnlineMeetingTranscript.Read.All`.
4. Sign in to the connector again as a member who organized or was invited to a transcribed Teams meeting.
5. Ask: "What was decided in yesterday's <meeting name>? Use the Teams transcript."

## What turning it off does

The three tools disappear from capability search and their routes answer `404 feature_disabled`. The permission checkbox is hidden from connectors that do not have it selected; a connector that already has it keeps the saved choice and shows the checkbox so an admin can clear it. Until it is cleared, that connector still asks Microsoft for the two scopes at sign-in. Nothing is stored for this feature, so there is no data to clean up. Mail, calendar, files and Teams chats are unaffected.

## What to watch

- `409 needs_connection`: the permission is not selected on the connector, or the member's sign-in predates it or lacks admin consent. The member signs in again after consent.
- `502 microsoft_graph_error` with `retryable: false`: a Teams administrator has turned off Graph access to transcripts (`GraphAccessToTranscriptsDisabled`). Only they can change it.
- `speakerAttribution: false` on a successful read: the Teams administrator does not allow speaker names, so Den asked Microsoft for the text without them.
- Other `502`s carry Microsoft's status and error code, never its message text, because that text can repeat the join link. Typical causes: the member was not invited, the meeting expired, or it was not created from a calendar event.
- Not covered: recordings, attendance reports, ad hoc calls, channel message search, and finding the join link from an invitation email.

Microsoft's behavior for channel meetings, external-tenant meetings and recurring series was not verified against a live tenant when this shipped; verify with a test tenant before turning it on widely.
