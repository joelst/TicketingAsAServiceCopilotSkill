# Plan A: Copilot Skill for Ticketing As A Service API

## Goal
Create a Copilot skill that can safely read and update tickets through a small tool surface backed by a single API adapter.

## Why this shape
- The API contract is already stable in apiDefinition.swagger.json.
- Regional host differences are known and isolated to host selection.
- Authentication and timezone behavior are well defined in connector metadata and docs.

## Rubber duck architecture

### Layer 1: Skill behavior
Responsibilities:
- Interpret user intent.
- Collect missing required fields.
- Confirm write operations before execution.
- Choose the smallest correct tool call.

Non-responsibilities:
- Building URLs.
- HTTP retry logic.
- Auth key handling details.

### Layer 2: Tool contract
Current published tool surface:
- list_tickets
- get_ticket
- create_ticket
- update_ticket_status
- update_ticket
- add_comment
- get_instance
- validation_write_closed_ticket_comment
- find_my_unresolved_tickets
- find_my_tickets_with_unread_updates

Keep tool inputs small and typed. Keep responses close to API envelopes so downstream prompts stay predictable.

Optional/tooling note:
- `validation_write_closed_ticket_comment` is intended for validation runs and can be treated as optional outside test workflows.

### Layer 3: API adapter
Single module handles:
- Region host selection: us, eu, apac.
- Base path: /ticketing/v1.
- API key query injection as key.
- Timezone fallback: request timezone then connection default timezone.
- Error normalization for 400, 401, 404, 429, 500.

## Phased build

### Phase 1
- Ship read-only calls: list_tickets, get_ticket, get_instance.
- Add pagination handling using continuation token.
- Add rate-limit friendly retry policy for 429.

### Phase 2
- Add write calls: create_ticket, update_ticket_status, update_ticket, add_comment.
- Add confirmation gate for status changes and comments.
- Add strict validation for required request body fields.

### Phase 3
- Add validation utility action: validation_write_closed_ticket_comment.
- Add practical utility reads: find_my_unresolved_tickets, find_my_tickets_with_unread_updates.
- Add conversation eval set for realistic prompts.
- Add telemetry for intent, endpoint, success, latency.
- Tune prompts for custom workflow status names.

## Acceptance criteria
- A user can list open tickets with filters in one request.
- A user can create a ticket after a single follow-up for missing requestor or user fields.
- A user can update status safely with confirmation.
- A user receives actionable errors for auth and rate limit failures.

## Open decisions to confirm
- Should region be fixed per connection or selectable per request.
- Whether validation and practical utility tools should stay in the default surface or remain optional/test-only.
- Whether private comments are needed now or later.
