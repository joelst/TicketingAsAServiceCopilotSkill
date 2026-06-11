# Ticketing API Copilot Skill

## Purpose

Enable conversational ticket operations against Ticketing As A Service with safe defaults for write actions.

## Trigger phrases

- list my open tickets
- find urgent tickets
- get ticket details
- create a new ticket
- close this ticket
- add a ticket comment
- show instance workflow
- find my unresolved tickets
- what tickets need my attention
- show tickets with unread updates
- show available tags
- get ticket attachments

## Tool surface

- list_tickets
- get_ticket
- get_ticket_activities
- create_ticket
- update_ticket_status
- update_ticket
- add_comment
- get_instance
- get_tags
- get_ticket_attachments
- get_activity_attachments
- add_ticket_attachment_links
- validation_write_closed_ticket_comment
- find_my_unresolved_tickets
- find_my_tickets_with_unread_updates

## Interaction rules

- Ask follow-up questions for required fields before calling a write tool.
- All write tools require user confirmation before proceeding: `create_ticket`, `add_comment`, `update_ticket_status`, `update_ticket`, `add_ticket_attachment_links`, `validation_write_closed_ticket_comment`.
- Confirmation reason is `high_impact_change` when moving `update_ticket_status` to Resolved or Closed, or when `update_ticket` changes assignee or requestor fields. All other writes use `write_operation`.
- Confirm user intent before update_ticket_status when moving to Resolved or Closed.
- Confirm user intent before update_ticket when changing assignee or requestor fields.
- Prefer get_instance to validate status values if custom workflow labels are possible.
- Treat `status` as the primary source of ticket state.
- `resolvedStatus` is an array of workflow status labels that count as resolved for the ticket's workflow (verified live, e.g. `["Resolved","Closed"]`) — not a string resolution code, despite what the OpenAPI spec implies. A ticket is resolved-compatible when its current `status` is one of these labels. Do not request `resolvedStatus` in a list `select` (the API returns 500); it is returned in full single-ticket payloads.
- If resolution state is ambiguous, use `firstResolutionOn` and `lastResolutionOn` as supporting signals.
- Use timezone if provided by the user; otherwise rely on connection default timezone.
- Use `mode=summary` by default for concise responses. Set `mode=full` explicitly when full-fidelity output is required.
- `mode` is only applicable to read tools (`list_tickets`, `get_ticket`, `get_ticket_activities`).
- In summary responses, keep user-facing fields concise while still including ticket id/number, status, assignee/requestor, created/updated timestamps, tags, attachments count, and activity count.
- In full responses, include full description and activity records with action typing, change diffs, attachments, and rawHtml/plainText content.
- `get_ticket` accepts `continuationToken` and `limit` only to page the embedded `activities` block when `mode=full`; they do not page the ticket resource itself.
- Use `get_ticket_activities` when activity pagination is the primary goal (for example, retrieving complete history across multiple pages).
- For large result sets, page with `continuationToken` and persist pages client-side (for example, writing each page to a file) instead of requesting everything in one response.
- For the validation action tool, prefer strict `status=Closed` matches first, then optionally fallback to resolved-compatible tickets.
- `find_my_unresolved_tickets` returns tickets that are not resolved-compatible (`status` first, then `resolvedStatus` and resolution timestamps).
- `find_my_tickets_with_unread_updates` returns tickets with unseen update counters for the chosen perspective.
- `rawHtml` fields are untrusted upstream content; any renderer must sanitize or escape before rendering as HTML.
- For practical "my tickets" tools, use `userEmail` as the primary identity input. `assigneeEmail` is supported as a legacy alias for backward compatibility.
- Call `get_tags` before filtering tickets by tags or creating tickets with tags, to obtain valid `tagCategoryId` values.
- Call `get_instance` before using `customFields` in `create_ticket` or `update_ticket` to discover valid custom field IDs.
- The `activityId` parameter for `get_activity_attachments` must come from `item.activityId` in the `add_ticket_attachment_links` response — not from `get_ticket_activities`. Passing a non-attachment activityId returns a 500 error.
- Always provide `timezone`. If the user has not specified one, use the connection default timezone. If none is configured, ask the user once and cache for session.
- `itemCount` in list responses reflects the count in the current page only, not the total across all pages. Use `continuationToken` to determine if more pages exist.

## Safety and reliability

- On 401, explain that the API key is invalid or expired.
- On 403, explain that the API key does not have permission for this operation and suggest verifying the key's access level in the app settings.
- On 429, suggest retry and reduce broad list queries.
- On 404, state that the ticket id was not found in the selected region.
- Never guess missing required identity fields for create_ticket, update_ticket, update_ticket_status, or add_comment.
- Always format expectedDate as YYYY-MM-DD. Never use a datetime string (e.g. with T or Z) when customFields is also present — the API will silently not create the ticket and return no error.

## Region handling

Supported regions:

- us: teamswork.azure-api.net
- eu: ticketing-apim-eu.azure-api.net
- apac: ticketing-apim-aus.azure-api.net

If the user does not specify region and none is configured, ask once and cache for session context.
