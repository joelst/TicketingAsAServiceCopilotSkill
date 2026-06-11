# Adapter Spec for Ticketing API Skill

## Objective

Provide one transport module that all tools use so auth, region, timezone, and error handling are consistent.

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
- add_ticket_attachment_links -> POST /tickets/{ticketId}/attachments

Composite tools (built on the endpoints above, no new routes):

- validation_write_closed_ticket_comment -> list_tickets + add_comment + GET /tickets/{ticketId}/activities
- find_my_unresolved_tickets -> paginated list_tickets with client-side filtering
- find_my_tickets_with_unread_updates -> paginated list_tickets with client-side filtering

## Request handling

- Always append `key` as a query parameter from connection secret. This API does not use the standard `Ocp-Apim-Subscription-Key` header — the gateway returns 401 for header-based auth.
- Add timezone query value when present in tool input.
- If timezone is omitted, use connection default timezone when configured.
- Preserve header continuationToken for pagination in list_tickets.

## Response handling

- Pass through API envelope fields such as item, items, message, error.
- For list_tickets, also return continuation token from response header.

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

The `select` parameter uses field names from the API's documented list (`id`, `ticketId`, `createdOn`, etc.). The dispatcher's select strings also use `ticketNo`, `lastInteraction`, `assigneeUnseenEventCnt`, and `requestorUnseenEventCnt` — these are not in the public OpenAPI docs and may be undocumented extensions. If they are absent from API responses the practical tools (`find_my_*`) will silently return null for those fields. Verify against a live instance when first deploying.

Do not name `resolvedStatus` in a list `select`: the gateway returns 500 (verified live in the `us` region). It is returned by default in list payloads and in full single-ticket payloads, so read it from there instead of selecting it.

`resolvedStatus` is an array of workflow status labels (verified live, e.g. `["Resolved","Closed"]`), not the string resolution code the OpenAPI spec implies. `toTicketShape` preserves the array (or null), and `isResolvedCompatible` treats a ticket as resolved when its current `status` appears in that array.

## Logging and telemetry

Capture per call:

- toolName
- region
- endpoint
- durationMs
- statusCode
- retryCount
- success
