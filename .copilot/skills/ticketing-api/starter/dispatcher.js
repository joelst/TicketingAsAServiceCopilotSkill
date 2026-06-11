import { TicketingApiAdapter } from './adapter.js';

const WRITE_TOOLS = new Set([
  'create_ticket',
  'update_ticket',
  'update_ticket_status',
  'add_comment',
  'validation_write_closed_ticket_comment'
]);

function isResolvedCompatible (ticket) {
  const status = ticket && ticket.status;
  if (status === 'Closed' || status === 'Resolved') {
    return true;
  }

  const resolvedStatus = Array.isArray(ticket && ticket.resolvedStatus) ? ticket.resolvedStatus : [];
  // Some tenants always include ['Resolved','Closed'] as policy values.
  // Treat a ticket as resolved only when its CURRENT status is in that set.
  if (status && resolvedStatus.includes(status)) {
    return true;
  }

  // Fallback only for payloads where status is missing.
  if (status) {
    return false;
  }

  return Boolean((ticket && ticket.firstResolutionOn) || (ticket && ticket.lastResolutionOn));
}

function buildValidationComment (input) {
  const stamp = new Date().toISOString();
  return [
    '### Connector Validation Note',
    '- Test type: live write-path validation',
    '- Trigger: Copilot skill validation action',
    `- Timestamp: ${stamp}`,
    '',
    'Result:',
    '- Posted via /tickets/{ticketId}/activities',
    `- Criteria: assignee=${input.assigneeEmail}, requestor=${input.requestorEmail}`
  ].join('\n');
}

function normalizeEmail (value) {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim().toLowerCase();
}

async function listCandidateTickets (adapter, input) {
  const maxPages = Number.isInteger(input.maxPages) ? input.maxPages : 8;
  const limit = Number.isInteger(input.limit) ? input.limit : 200;
  const stopOnFirstMatch = input.stopOnFirstMatch !== false;
  const candidates = [];
  const expectedRequestorEmail = normalizeEmail(input.requestorEmail);
  const expectedAssigneeEmail = normalizeEmail(input.assigneeEmail);

  let continuationToken;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await adapter.listTickets({
      region: input.region,
      timezone: input.timezone,
      limit,
      orderBy: 'lastInteraction',
      order: 'DESC',
      continuationToken
    });

    const items = Array.isArray(response.data && response.data.items) ? response.data.items : [];
    const filtered = items.filter((ticket) => {
      const requestorEmail = normalizeEmail(ticket && ticket.requestor && ticket.requestor.email);
      const assigneeEmail = normalizeEmail(ticket && ticket.assignee && ticket.assignee.email);
      return requestorEmail === expectedRequestorEmail && assigneeEmail === expectedAssigneeEmail;
    });
    candidates.push(...filtered);

    if (stopOnFirstMatch && candidates.length > 0) {
      break;
    }

    continuationToken = response.meta && response.meta.continuationToken;
    if (!continuationToken) {
      break;
    }
  }

  return candidates;
}

async function runValidationWrite (adapter, input) {
  const candidates = await listCandidateTickets(adapter, input);

  const strictClosed = candidates.filter((ticket) => ticket && ticket.status === 'Closed');
  const resolvedCompatible = candidates.filter((ticket) => isResolvedCompatible(ticket));

  let target = strictClosed[0];
  let usedFallback = false;
  if (!target && input.allowResolvedFallback !== false) {
    target = resolvedCompatible[0];
    usedFallback = Boolean(target);
  }

  if (!target) {
    throw new Error('No qualifying ticket found for validation action.');
  }

  const comment = input.comment || buildValidationComment(input);
  const user = {
    id: target.assignee && target.assignee.id,
    name: target.assignee && target.assignee.name,
    email: target.assignee && target.assignee.email
  };

  if (!user.id || !user.name || !user.email) {
    throw new Error('Validation write requires target.assignee with id, name, and email.');
  }

  const writeResult = await adapter.addComment({
    region: input.region,
    timezone: input.timezone,
    ticketId: target.id,
    comment,
    user
  });

  const activities = await adapter.request({
    region: input.region,
    method: 'GET',
    path: `/tickets/${encodeURIComponent(target.id)}/activities`,
    query: {
      timezone: input.timezone
    }
  });

  const items = Array.isArray(activities.data && activities.data.items) ? activities.data.items : [];
  const exactMatches = items.filter((item) => item && item.comment === comment).length;

  return {
    data: {
      targetTicketId: target.id,
      targetStatus: target.status,
      targetTitle: target.title,
      writeMessage: writeResult.data && writeResult.data.message,
      verificationExactCommentMatches: exactMatches,
      usedFallback,
      scannedCandidates: candidates.length
    },
    meta: {
      statusCode: 200
    }
  };
}

function hasUnreadUpdates (ticket, perspective) {
  const assigneeUnread = Number(ticket && ticket.assigneeUnseenEventCnt) || 0;
  const requestorUnread = Number(ticket && ticket.requestorUnseenEventCnt) || 0;

  if (perspective === 'requestor') {
    return requestorUnread > 0;
  }
  if (perspective === 'any') {
    return assigneeUnread > 0 || requestorUnread > 0;
  }

  return assigneeUnread > 0;
}

function resolveEffectiveUserEmail (input, config, toolName) {
  const effectiveEmail = input.userEmail || input.assigneeEmail || config.currentUserEmail;
  if (!effectiveEmail) {
    throw new Error(`userEmail is required for ${toolName}. Provide input.userEmail (or legacy input.assigneeEmail) or configure currentUserEmail.`);
  }

  return effectiveEmail;
}

async function listMyTickets (adapter, input, predicate) {
  const maxPages = Number.isInteger(input.maxPages) ? input.maxPages : 8;
  const limit = Number.isInteger(input.limit) ? input.limit : 200;
  const perspective = input.perspective || 'assignee';
  const top = Number.isInteger(input.top) ? input.top : 25;
  const expectedUserEmail = normalizeEmail(input.userEmail);

  const items = [];
  let continuationToken;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await adapter.listTickets({
      region: input.region,
      timezone: input.timezone,
      limit,
      orderBy: input.orderBy || 'lastInteraction',
      order: input.order || 'DESC',
      continuationToken
    });

    const batch = Array.isArray(response.data && response.data.items) ? response.data.items : [];
    const mine = batch.filter((ticket) => {
      const assigneeEmail = normalizeEmail(ticket && ticket.assignee && ticket.assignee.email);
      const requestorEmail = normalizeEmail(ticket && ticket.requestor && ticket.requestor.email);

      if (perspective === 'requestor') {
        return requestorEmail === expectedUserEmail;
      }
      if (perspective === 'any') {
        return assigneeEmail === expectedUserEmail || requestorEmail === expectedUserEmail;
      }

      return assigneeEmail === expectedUserEmail;
    });

    items.push(...mine.filter(predicate));

    if (items.length >= top) {
      break;
    }

    continuationToken = response.meta && response.meta.continuationToken;
    if (!continuationToken) {
      break;
    }
  }

  const clipped = items.slice(0, top);

  return {
    data: {
      itemCount: clipped.length,
      items: clipped,
      totalMatchedBeforeTop: items.length
    },
    meta: {
      statusCode: 200
    }
  };
}

async function findMyUnresolvedTickets (adapter, input) {
  return listMyTickets(adapter, input, (ticket) => !isResolvedCompatible(ticket));
}

async function findMyTicketsWithUnreadUpdates (adapter, input) {
  const perspective = input.perspective || 'assignee';
  return listMyTickets(adapter, input, (ticket) => hasUnreadUpdates(ticket, perspective));
}

function needsEscalatedConfirmation (toolName, input) {
  if (toolName === 'update_ticket_status') {
    return input.status === 'Resolved' || input.status === 'Closed';
  }

  if (toolName === 'update_ticket') {
    const ticket = input.ticket || {};
    return Boolean(ticket.assignee || ticket.requestor);
  }

  return false;
}

export function createToolDispatcher (config) {
  const adapter = config.adapter || (typeof config.adapterFactory === 'function'
    ? config.adapterFactory(config)
    : new TicketingApiAdapter(config));

  return async function dispatchTool (toolName, input, options = {}) {
    const confirmAction = options.confirmAction || (async () => true);

    if (WRITE_TOOLS.has(toolName)) {
      const confirmationReason = needsEscalatedConfirmation(toolName, input)
        ? 'high_impact_change'
        : 'write_operation';

      const confirmed = await confirmAction({
        toolName,
        input,
        confirmationReason
      });

      if (!confirmed) {
        return {
          cancelled: true,
          message: 'Operation cancelled by user before write action.'
        };
      }
    }

    switch (toolName) {
      case 'list_tickets':
        return adapter.listTickets(input);
      case 'get_ticket':
        return adapter.getTicket(input);
      case 'create_ticket':
        return adapter.createTicket(input);
      case 'update_ticket':
        return adapter.updateTicket(input);
      case 'update_ticket_status':
        return adapter.updateTicketStatus(input);
      case 'add_comment':
        return adapter.addComment(input);
      case 'get_instance':
        return adapter.getInstance(input);
      case 'validation_write_closed_ticket_comment':
        if (!input.requestorEmail) {
          throw new Error('requestorEmail is required for validation_write_closed_ticket_comment to prevent writes against unintended tickets.');
        }
        return runValidationWrite(adapter, {
          region: input.region || config.defaultRegion || 'us',
          timezone: input.timezone || config.defaultTimezone,
          assigneeEmail: input.assigneeEmail,
          requestorEmail: input.requestorEmail,
          allowResolvedFallback: input.allowResolvedFallback,
          limit: input.limit,
          maxPages: input.maxPages,
          stopOnFirstMatch: input.stopOnFirstMatch,
          comment: input.comment
        });
      case 'find_my_unresolved_tickets':
        {
          const effectiveUserEmail = resolveEffectiveUserEmail(input, config, toolName);
          return findMyUnresolvedTickets(adapter, {
            region: input.region || config.defaultRegion || 'us',
            timezone: input.timezone || config.defaultTimezone,
            userEmail: effectiveUserEmail,
            perspective: input.perspective,
            limit: input.limit,
            maxPages: input.maxPages,
            top: input.top,
            orderBy: input.orderBy,
            order: input.order
          });
        }
      case 'find_my_tickets_with_unread_updates':
        {
          const effectiveUserEmail = resolveEffectiveUserEmail(input, config, toolName);
          return findMyTicketsWithUnreadUpdates(adapter, {
            region: input.region || config.defaultRegion || 'us',
            timezone: input.timezone || config.defaultTimezone,
            userEmail: effectiveUserEmail,
            perspective: input.perspective,
            limit: input.limit,
            maxPages: input.maxPages,
            top: input.top,
            orderBy: input.orderBy,
            order: input.order
          });
        }
      default:
        throw new Error(`Unsupported tool: ${toolName}`);
    }
  };
}
