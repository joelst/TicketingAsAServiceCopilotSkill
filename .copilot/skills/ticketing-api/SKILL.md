# Ticketing API Copilot Skill

## Purpose

Enable conversational IT Helpdesk operations against Ticketing As A Service: intake, assignment, private vs requestor-visible comments, workflow/status changes, attachments, and tickets that need attention. Keep safe defaults for write actions. The HTTP API is the Ticketing Public API 1.1.0 — do not invent helpdesk-only endpoints.

## Trigger phrases

- take an IT helpdesk ticket / intake a new request
- list my open tickets
- find urgent tickets
- tickets that need my attention
- assign this ticket to ...
- add an internal note / private comment
- add a requestor-visible comment
- get ticket details
- create a new ticket
- close this ticket / resolve this ticket
- show instance workflow
- find my unresolved tickets
- show tickets with unread updates
- show available tags
- get ticket attachments
- attach a link to this ticket

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
- Prefer get_instance to validate status values and allowed workflow transitions if custom workflow labels are possible. Full `get_ticket` payloads also include `workflow` / `isCustomWorkflow`.
- Treat `status` as the primary source of ticket state.
- Default workflow labels are Open, Reopened, In Progress, Resolved, and Closed (not "Started"). Custom workflows can use other IDs.
- On `list_tickets`, `status` is a legacy resolved-state filter (Open/Reopened/In Progress => unresolved; Resolved/Closed => resolved). Use `statusId` for an exact workflow-state match.
- `resolvedStatus` is an array of workflow status labels that count as resolved for the ticket's workflow (verified live, e.g. `["Resolved","Closed"]`; OpenAPI 1.1.0 documents it as an array). A ticket is resolved-compatible when its current `status` is one of these labels. Do not request `resolvedStatus` in a list `select` (the API returns 500); it is returned in full single-ticket payloads.
- If resolution state is ambiguous, use `firstResolutionOn` and `lastResolutionOn` as supporting signals.
- `add_comment` accepts `isPrivate` (default false). Set `isPrivate: true` for an internal/private comment not visible to the requestor; leave false for a requestor-visible update. OpenAPI 1.1.0 documents `isPrivate` on `insertCommentRequest`, `insertAttachmentLinkRequest`, `insertAttachmentMultipartRequest`, and `IActivity`. Shaped activities expose `isPrivate` (true/false, or null when the source omits it).
- `description` is plain text; `description_HTML` is sanitized HTML. When both are sent, description takes precedence. Request `include=description_HTML` on GET/POST/PUT ticket operations to receive HTML in the response.
- `comment` is plain text; `comment_HTML` is sanitized HTML. When both are sent, comment takes precedence. Request `include=comment_HTML` on activity and attachment-activity operations to receive HTML in the response.
- Use timezone if provided by the user; otherwise rely on connection default timezone.
- Use `mode=summary` by default for concise responses. Set `mode=full` explicitly when full-fidelity output is required.
- `mode` is only applicable to read tools (`list_tickets`, `get_ticket`, `get_ticket_activities`).
- In summary responses, keep user-facing fields concise while still including ticket id/number, status, assignee/requestor, created/updated timestamps, tags, attachments count, and activity count.
- In full responses, include full description and activity records with action typing, change diffs, attachments, workflow, and rawHtml/plainText content. Full mode requests `include=description_HTML` or `include=comment_HTML` as appropriate.
- OpenAPI 1.1.0 GET `/tickets/{ticketId}` does not page. `get_ticket` still accepts `continuationToken` and `limit` only to page the companion GET `/tickets/{ticketId}/activities` request when `mode=full`; they do not page the ticket resource itself.
- Use `get_ticket_activities` when activity pagination is the primary goal (for example, retrieving complete history across multiple pages). That operation documents `continuationToken`, `include`, and `limit` in OpenAPI 1.1.0.
- For large result sets, page with `continuationToken` and persist pages client-side (for example, writing each page to a file) instead of requesting everything in one response.
- For the validation action tool, prefer strict `status=Closed` matches first, then optionally fallback to resolved-compatible tickets.
- `find_my_unresolved_tickets` returns tickets that are not resolved-compatible (`status` first, then `resolvedStatus` and resolution timestamps).
- `find_my_tickets_with_unread_updates` returns tickets with unseen update counters for the chosen perspective — use this for "tickets that need my attention".
- `rawHtml` fields are untrusted upstream content; any renderer must sanitize or escape before rendering as HTML.
- For practical "my tickets" tools, use `userEmail` as the primary identity input. `assigneeEmail` is supported as a legacy alias for backward compatibility.
- Call `get_tags` before filtering tickets by tags or creating tickets with tags, to obtain valid `tagCategoryId` values.
- Call `get_instance` before using `customFields` in `create_ticket` or `update_ticket` to discover valid custom field IDs.
- The `activityId` parameter for `get_activity_attachments` must come from `item.activityId` in the `add_ticket_attachment_links` response — not from `get_ticket_activities`. Passing a non-attachment activityId returns a 500 error.
- Always provide `timezone`. If the user has not specified one, use the connection default timezone. If none is configured, ask the user once and cache for session.
- `itemCount` in list responses reflects the count in the current page only, not the total across all pages. Use `continuationToken` to determine if more pages exist.
- Link attachments via `add_ticket_attachment_links` (JSON). The API also accepts multipart file uploads on POST `/tickets/{ticketId}/attachments`; this skill does not expose a binary upload tool.

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

## Auth

Send the Ticketing instance API key as the `key` query parameter. OpenAPI 1.1.0 documents this as security scheme `apiKey` (`in: query`, `name: key`) and no longer lists `key` as a per-operation parameter or an `Ocp-Apim-Subscription-Key` header scheme. The working adapter continues to use `?key=` only — do not send `Ocp-Apim-Subscription-Key` (the gateway returns 401 for header-based auth).
