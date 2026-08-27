# Adapter Spec for Ticketing API Skill

## Objective

Provide one transport module that all tools use so auth, region, timezone, and error handling are consistent.

Canonical HTTP contract: Ticketing Public API **1.1.0** (`docs/ticketing-api.openapi.json`).

## Base routing

- us host: https://teamswork.azure-api.net
- eu host: https://ticketing-apim-eu.azure-api.net
- apac host: https://ticketing-apim-aus.azure-api.net
- base path: /ticketing/v1

## Endpoint mapping

- list_tickets -> GET /tickets
- get_ticket -> GET /tickets/{ticketId}
- create_ticket -> POST /tickets
- update_ticket -> PUT /tickets/{ticketId}
- update_ticket_status -> PUT /tickets/{ticketId}/status
- add_comment -> POST /tickets/{ticketId}/activities
- get_instance -> GET /instance
- get_tags -> GET /tags
- get_ticket_attachments -> GET /tickets/{ticketId}/attachments
- get_activity_attachments -> GET /tickets/activity/{activityId}/attachments
- add_ticket_attachment_links -> POST /tickets/{ticketId}/attachments (application/json link attachments)

Composite tools (built on the endpoints above, no new routes):

- validation_write_closed_ticket_comment -> list_tickets + add_comment + GET /tickets/{ticketId}/activities
- find_my_unresolved_tickets -> paginated list_tickets with client-side filtering
- find_my_tickets_with_unread_updates -> paginated list_tickets with client-side filtering

OpenAPI 1.1.0 POST `/tickets/{ticketId}/attachments` also accepts `multipart/form-data` file uploads (`insertAttachmentMultipartRequest`). The skill tool remains JSON link attachments only.

## Request handling

- Always append `key` as a query parameter from connection secret. OpenAPI 1.1.0 security scheme `apiKey` is `in: query`, `name: key`. Per-operation `key` parameters were removed vs 1.0; the header scheme `Ocp-Apim-Subscription-Key` was also removed from 1.1.0. The working adapter still sends `?key=` only — this API does not use `Ocp-Apim-Subscription-Key` (the gateway returns 401 for header-based auth).
- Add timezone query value when present in tool input. Keep sending it even on operations where 1.1.0 omits timezone from documented parameters (for example GET/POST activities) so session timezone stays consistent.
- If timezone is omitted, use connection default timezone when configured.
- Preserve header continuationToken for pagination in list_tickets and get_ticket_activities.
- Forward `include` when provided:
  - `description_HTML` on GET/POST /tickets and GET/PUT /tickets/{ticketId}
  - `comment_HTML` on GET/POST /tickets/{ticketId}/activities and POST /tickets/{ticketId}/attachments
- Forward `statusId` on GET /tickets for an exact workflow-state match. `status` remains the legacy resolved-state filter.

## Response handling

- Pass through API envelope fields such as item, items, message, error (see `ITicketResponse` / `IErrorResponse`).
- For list_tickets and get_ticket_activities, also return continuation token from response header or body.
- Ticket `description` is plain text; HTML is in `description_HTML` only when requested via `include`.
- Activity `comment` is plain text; HTML is in `comment_HTML` only when requested via `include`.
- Prefer `description_HTML` / `comment_HTML` for shaped `rawHtml` when present.

## Error normalization

Map to canonical errors:

- auth_error for 401
- forbidden for 403
- validation_error for 400
- not_found for 404
- rate_limit for 429
- upstream_error for 5xx

Include:

- statusCode
- canonicalType
- apiMessage
- retryable

Implementation note:

- Canonical errors are thrown as `Error` instances with `message` and `apiMessage` both populated, plus `statusCode`, `canonicalType`, `retryable`, and `meta` properties.

## Retry policy

- Retry only on 429 and selected 5xx responses.
- Exponential backoff with jitter.
- Maximum 3 retries.

## Known field name risks

The `select` parameter uses field names from the API's documented list (`id`, `ticketId`, `title`, `description`, `status`, `requestor`, `customFields`, `priority`, `assignee`, `expectedDate`, `resolution`, `firstResponseOn`, `firstResolutionOn`, `lastResolutionOn`, `createdOn`, `tags`, `lastUpdatedOn`, `isFrtEscalated`, `isRtEscalated`, `createdBy`, `lastUpdatedBy`, `lastResolutionComment`). Use `include=description_HTML` for HTML; include fields are retained even when select is present.

The dispatcher's select strings also use `ticketNo`, `lastInteraction`, `assigneeUnseenEventCnt`, and `requestorUnseenEventCnt`. OpenAPI 1.1.0 `ITicket` now documents `ticketNo`, `assigneeUnseenEventCnt`, and `requestorUnseenEventCnt`, and `lastInteraction` is a documented `orderBy` value, but those names are still absent from the GET /tickets `select` list. If they are absent from API responses the practical tools (`find_my_*`) will silently return null for those fields. Verify against a live instance when first deploying.

Do not name `resolvedStatus` in a list `select`: the gateway returns 500 (verified live in the `us` region). It is returned by default in list payloads and in full single-ticket payloads, so read it from there instead of selecting it.

`resolvedStatus` is an array of workflow status labels (verified live, e.g. `["Resolved","Closed"]`). OpenAPI 1.1.0 documents it as an array of strings. `toTicketShape` preserves the array (or null), and `isResolvedCompatible` treats a ticket as resolved when its current `status` appears in that array.

`add_comment` (POST /tickets/{id}/activities) accepts `isPrivate` in the request body. OpenAPI 1.1.0 `insertCommentRequest` documents the field (default false). Verified live: a comment posted with `isPrivate: true` reads back private, `false` reads back public. The adapter sends `isPrivate` (default false); shaped activities surface it.

`resolution` on update_ticket_status is optional, not required for Resolved/Closed (verified live: HTTP 200 without it). Do not enforce it in the schema.

## Logging and telemetry

Capture per call:

- toolName
- region
- endpoint
- durationMs
- statusCode
- retryCount
- success
