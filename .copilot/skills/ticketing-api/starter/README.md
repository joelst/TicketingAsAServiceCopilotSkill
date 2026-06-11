# Starter Adapter

This folder contains a plain JavaScript starter adapter for Plan A.

## What is included

- adapter.js: region-aware, key-authenticated API adapter with retry and normalized errors.

## Runtime expectations

- Node.js 18 or newer is only required for the optional starter adapter/dispatcher scripts in this folder (validated in CI on Node 18 and Node 22).
- API key from your Ticketing As A Service instance.

## Read-only smoke test

Use the PowerShell smoke test to validate connectivity before wiring the dispatcher.

```powershell
# Set in terminal directly (do not paste into chat)
$env:ticketingAPIKey = '...'
# or
$env:TICKETING_API_KEY = '...'

# North America default: us + timezone -5
.\smoke-test.ps1 -Region us -Timezone -5 -Limit 3
```

The script calls:

- GET /instance
- GET /tickets (limited)

## Minimal usage flow

1. Instantiate TicketingApiAdapter with apiKey and defaultRegion.
2. Wire each tool name to one adapter method.
3. Pass tool input directly after validation against tool-schema.json.

## Suggested next step

Build a tiny tool dispatcher layer that maps:

- list_tickets to listTickets
- get_ticket to getTicket
- create_ticket to createTicket
- update_ticket to updateTicket
- update_ticket_status to updateTicketStatus
- add_comment to addComment
- get_instance to getInstance

An example dispatcher is included in dispatcher.js.

## Built-in confirmation gating

The example dispatcher in dispatcher.js already enforces a confirmation gate before any write — you do not need to add it yourself. It calls the `confirmAction` callback you pass via `options` and aborts (returning `{ cancelled: true }`) when the callback returns a falsy value.

Gated write tools:

- create_ticket
- update_ticket
- update_ticket_status
- add_comment
- add_ticket_attachment_links
- validation_write_closed_ticket_comment

Each confirmation payload includes a `confirmationReason`:

- `high_impact_change` for update_ticket_status moving to `Resolved` or `Closed`, and for update_ticket changing `assignee` or `requestor`.
- `write_operation` for all other gated writes.

Read tools (list_tickets, get_ticket, get_instance, get_tags, get_ticket_attachments, get_activity_attachments, find_my_unresolved_tickets, find_my_tickets_with_unread_updates) bypass the gate. If no `confirmAction` is supplied, the dispatcher defaults to allowing the write, so provide one to enforce interactive approval.

## Known limitations

- `itemCount` in list responses is the page item count, not the total across all pages. Inspect `continuationToken` to determine whether more pages exist.
- `defaultTimezone` is effectively required in the adapter config — the API marks `timezone` as a required parameter on every endpoint. If omitted the API uses its own server default, which may differ from the user's local time.
- The `activityId` parameter for `get_activity_attachments` must come from `item.activityId` in the `add_ticket_attachment_links` response. Passing an activityId sourced from `get_ticket_activities` returns a 500 error.
- This API does not accept `Ocp-Apim-Subscription-Key` as a request header despite what the OpenAPI spec implies. Authentication is via `?key=` query parameter only.
