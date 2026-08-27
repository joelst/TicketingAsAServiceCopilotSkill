import { TicketingApiAdapter } from './adapter.js';

const WRITE_TOOLS = new Set([
  'create_ticket',
  'update_ticket',
  'update_ticket_status',
  'add_comment',
  'validation_write_closed_ticket_comment',
  'add_ticket_attachment_links'
]);

const LIST_TICKET_SELECT_FIELDS = 'id,ticketNo,title,priority,status,requestor,assignee,createdOn,lastUpdatedOn,lastInteraction,tags';
const MY_TICKETS_SELECT_FIELDS = 'id,ticketNo,title,priority,status,requestor,assignee,createdOn,lastUpdatedOn,lastInteraction,firstResolutionOn,lastResolutionOn,assigneeUnseenEventCnt,requestorUnseenEventCnt,tags';
const VALIDATION_TICKET_SELECT_FIELDS = 'id,ticketNo,title,priority,status,requestor,assignee,firstResolutionOn,lastResolutionOn';

function parseTimezoneOffsetMinutes (timezone) {
  if (typeof timezone === 'number' && Number.isFinite(timezone)) {
    return Math.trunc(timezone * 60);
  }

  if (typeof timezone !== 'string') {
    return null;
  }

  const trimmed = timezone.trim();
  if (!trimmed) {
    return null;
  }

  const parsedNumeric = Number(trimmed);
  if (!Number.isNaN(parsedNumeric) && Number.isFinite(parsedNumeric)) {
    return Math.trunc(parsedNumeric * 60);
  }

  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] || '0');

  if (hours > 23 || minutes > 59) {
    return null;
  }

  return sign * ((hours * 60) + minutes);
}

function toOffsetTimestamp (value, timezone) {
  if (!value) {
    return value || null;
  }

  const textValue = String(value);
  const offsetMinutes = parseTimezoneOffsetMinutes(timezone);
  if (offsetMinutes === null) {
    return value;
  }

  const hasExplicitTimezone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(textValue);
  const isNaiveIsoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(textValue);
  const source = new Date(!hasExplicitTimezone && isNaiveIsoTimestamp ? `${textValue}Z` : value);
  if (Number.isNaN(source.getTime())) {
    return value;
  }

  const shifted = new Date(source.getTime() + (offsetMinutes * 60 * 1000));
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteMinutes / 60)).padStart(2, '0');
  const offsetRemainderMinutes = String(absoluteMinutes % 60).padStart(2, '0');

  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const hours = String(shifted.getUTCHours()).padStart(2, '0');
  const minutes = String(shifted.getUTCMinutes()).padStart(2, '0');
  const seconds = String(shifted.getUTCSeconds()).padStart(2, '0');
  const milliseconds = String(shifted.getUTCMilliseconds()).padStart(3, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${sign}${offsetHours}:${offsetRemainderMinutes}`;
}

function toPlainText (value) {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  return text || null;
}

function toRichText (value) {
  if (value === undefined || value === null) {
    return {
      rawHtml: null,
      plainText: null
    };
  }

  const rawHtml = String(value);
  return {
    rawHtml,
    plainText: toPlainText(rawHtml)
  };
}

function toTicketDescription (ticket) {
  const html = ticket && ticket.description_HTML;
  const text = ticket && ticket.description;
  if (html !== undefined && html !== null && html !== '') {
    return {
      rawHtml: String(html),
      plainText: toPlainText(html) || (text ? String(text) : null)
    };
  }
  return toRichText(text);
}

function toActivityComment (activity) {
  const html = activity && activity.comment_HTML;
  const text = activity && (activity.comment || activity.message);
  if (html !== undefined && html !== null && html !== '') {
    return {
      rawHtml: String(html),
      plainText: toPlainText(html) || (text ? String(text) : null)
    };
  }
  return toRichText(text);
}

function toUserSummary (user) {
  if (typeof user === 'string') {
    return {
      id: null,
      name: user || null,
      email: null
    };
  }

  if (!user || typeof user !== 'object') {
    return {
      id: null,
      name: null,
      email: null
    };
  }

  return {
    id: user.id || null,
    name: user.name || null,
    email: user.email || null
  };
}

function toChanges (activity) {
  const candidates = Array.isArray(activity && activity.changes)
    ? activity.changes
    : [];

  return candidates.map((entry) => ({
    field: (entry && (entry.name || entry.field || entry.key)) || null,
    oldValue: entry && Object.prototype.hasOwnProperty.call(entry, 'oldValue') ? entry.oldValue : null,
    newValue: entry && Object.prototype.hasOwnProperty.call(entry, 'newValue') ? entry.newValue : null
  }));
}

function normalizeActivityAction (activity, changes) {
  const raw = (activity && (activity.action || activity.type || activity.eventType || activity.name)) || '';
  const lowered = String(raw).trim().toLowerCase();

  if (lowered.includes('start ticket') || lowered === 'started' || lowered === 'start') {
    return { action: 'started', actionRaw: raw || null };
  }
  if (lowered.includes('create') || lowered === 'created') {
    return { action: 'created', actionRaw: raw || null };
  }
  if (lowered.includes('edit') || lowered.includes('update') || lowered === 'edited') {
    return { action: 'edited', actionRaw: raw || null };
  }
  if (lowered.includes('comment')) {
    return { action: 'commented', actionRaw: raw || null };
  }
  if (Array.isArray(changes) && changes.length > 0) {
    return { action: 'edited', actionRaw: raw || null };
  }
  if (activity && activity.comment) {
    return { action: 'commented', actionRaw: raw || null };
  }

  return { action: 'unknown', actionRaw: raw || null };
}

function toAttachments (activity) {
  const attachments = Array.isArray(activity && activity.attachments)
    ? activity.attachments
    : [];

  return attachments.map((attachment) => ({
    // Preserve legitimate zero-byte attachments; null only when missing/invalid.
    size: Number.isFinite(Number(attachment && attachment.size)) ? Number(attachment.size) : null,
    id: (attachment && (attachment.id || attachment.attachmentId)) || null,
    name: (attachment && (attachment.name || attachment.fileName || attachment.filename || attachment.caption)) || null,
    contentType: (attachment && attachment.contentType) || null,
    url: (attachment && (attachment.url || attachment.downloadUrl || attachment.src)) || null
  }));
}

function toActivitySummary (activity, timezone) {
  const changes = toChanges(activity);
  const { action, actionRaw } = normalizeActivityAction(activity, changes);
  const attachments = toAttachments(activity);
  const richComment = toActivityComment(activity);
  const hasChanges = Array.isArray(activity && activity.changes);
  const hasAttachments = Array.isArray(activity && activity.attachments);

  return {
    id: (activity && (activity.id || activity.activityId)) || null,
    action,
    actionRaw,
    timestamp: toOffsetTimestamp((activity && (activity.createdDateTime || activity.dateCreated || activity.createdOn || activity.timestamp || activity.updatedOn)) || null, timezone),
    user: toUserSummary(activity && (activity.createdBy || activity.author || activity.user)),
    comment: {
      rawHtml: richComment.rawHtml,
      plainText: richComment.plainText
    },
    isPrivate: activity && typeof activity.isPrivate === 'boolean' ? activity.isPrivate : null,
    changesCount: hasChanges ? changes.length : null,
    attachmentsCount: hasAttachments ? attachments.length : null
  };
}

function toActivityFull (activity, timezone) {
  const changes = toChanges(activity);
  const { action, actionRaw } = normalizeActivityAction(activity, changes);
  const attachments = toAttachments(activity);
  const richComment = toActivityComment(activity);

  return {
    id: (activity && (activity.id || activity.activityId)) || null,
    action,
    actionRaw,
    timestamp: toOffsetTimestamp((activity && (activity.createdDateTime || activity.dateCreated || activity.createdOn || activity.timestamp || activity.updatedOn)) || null, timezone),
    user: toUserSummary(activity && (activity.createdBy || activity.author || activity.user)),
    comment: richComment,
    isPrivate: activity && typeof activity.isPrivate === 'boolean' ? activity.isPrivate : null,
    changes,
    attachments
  };
}

function toTicketShape (ticket, timezone, mode) {
  const emptyShape = {
    id: null,
    ticketNo: null,
    title: null,
    status: null,
    priority: null,
    requestor: toUserSummary(null),
    assignee: toUserSummary(null),
    createdOn: null,
    updatedOn: null,
    lastInteraction: null,
    resolvedStatus: null,
    firstResolutionOn: null,
    lastResolutionOn: null,
    tags: [],
    unseenUpdates: {
      assignee: null,
      requestor: null
    },
    attachmentsCount: null,
    activityCount: null,
    description: toRichText(null)
  };

  if (!ticket || typeof ticket !== 'object') {
    if (mode === 'full') {
      emptyShape.attachments = [];
      emptyShape.isCustomWorkflow = null;
      emptyShape.workflow = [];
    }
    return emptyShape;
  }

  const description = toTicketDescription(ticket);
  const hasAttachments = Array.isArray(ticket.attachments);
  const attachments = hasAttachments ? ticket.attachments : [];
  const hasActivityCount = Object.prototype.hasOwnProperty.call(ticket, 'activityCount');
  const numericActivityCount = Number(ticket.activityCount);
  const hasAssigneeUnseen = Object.prototype.hasOwnProperty.call(ticket, 'assigneeUnseenEventCnt');
  const hasRequestorUnseen = Object.prototype.hasOwnProperty.call(ticket, 'requestorUnseenEventCnt');
  const assigneeUnseen = Number(ticket.assigneeUnseenEventCnt);
  const requestorUnseen = Number(ticket.requestorUnseenEventCnt);
  const tags = Array.isArray(ticket.tags)
    ? ticket.tags.map((tag) => ({
      tagCategoryId: (tag && tag.tagCategoryId) || null,
      text: (tag && tag.text) || null
    }))
    : [];

  const base = {
    id: ticket.id || null,
    ticketNo: ticket.ticketNo || null,
    title: ticket.title || null,
    status: ticket.status || null,
    priority: ticket.priority || null,
    requestor: toUserSummary(ticket.requestor),
    assignee: toUserSummary(ticket.assignee),
    createdOn: toOffsetTimestamp(ticket.createdOn || null, timezone),
    updatedOn: toOffsetTimestamp(ticket.lastUpdatedOn || ticket.updatedOn || null, timezone),
    lastInteraction: toOffsetTimestamp(ticket.lastInteraction || null, timezone),
    resolvedStatus: Array.isArray(ticket.resolvedStatus) ? ticket.resolvedStatus : null,
    firstResolutionOn: toOffsetTimestamp(ticket.firstResolutionOn || null, timezone),
    lastResolutionOn: toOffsetTimestamp(ticket.lastResolutionOn || null, timezone),
    tags,
    unseenUpdates: {
      assignee: hasAssigneeUnseen && Number.isFinite(assigneeUnseen) ? assigneeUnseen : null,
      requestor: hasRequestorUnseen && Number.isFinite(requestorUnseen) ? requestorUnseen : null
    },
    attachmentsCount: hasAttachments ? attachments.length : null,
    activityCount: hasActivityCount && Number.isFinite(numericActivityCount) ? numericActivityCount : null,
    description
  };

  if (mode === 'full') {
    base.attachments = attachments;
    base.isCustomWorkflow = Object.prototype.hasOwnProperty.call(ticket, 'isCustomWorkflow')
      ? Boolean(ticket.isCustomWorkflow)
      : null;
    base.workflow = Array.isArray(ticket.workflow) ? ticket.workflow : [];
  }

  return base;
}

function resolveMode (input) {
  if (input && input.mode === 'full') {
    return 'full';
  }

  return 'summary';
}

function isResolvedCompatible (ticket) {
  const status = ticket && ticket.status;
  if (status === 'Closed' || status === 'Resolved') {
    return true;
  }

  // resolvedStatus is a list of workflow status labels that count as a resolved state
  // for this ticket's (possibly custom) workflow — verified live: the API returns it as
  // an array such as ['Resolved','Closed'], NOT a string code. Treat the ticket as
  // resolved when its current status is one of those labels. Note: resolvedStatus is not
  // a selectable list field (selecting it returns 500), so this branch only applies where
  // the field is present (e.g. full single-ticket payloads).
  if (status && Array.isArray(ticket && ticket.resolvedStatus)) {
    return ticket.resolvedStatus.includes(status);
  }

  // Fallback only for payloads where status is missing.
  if (status) {
    return false;
  }

  return Boolean((ticket && ticket.firstResolutionOn) || (ticket && ticket.lastResolutionOn));
}

function buildValidationComment () {
  const stamp = new Date().toISOString();
  return [
    '### Connector Validation Note',
    '- Test type: live write-path validation',
    '- Trigger: Copilot skill validation action',
    `- Timestamp: ${stamp}`
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
      select: VALIDATION_TICKET_SELECT_FIELDS,
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

  const comment = input.comment || buildValidationComment();
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
  const mode = 'summary';
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
      select: input.select || MY_TICKETS_SELECT_FIELDS,
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
      items: clipped.map((ticket) => toTicketShape(ticket, input.timezone, mode)),
      totalMatchedBeforeTop: items.length
    },
    meta: {
      statusCode: 200
    }
  };
}

async function listTicketsForDisplay (adapter, input) {
  const mode = resolveMode(input);
  const defaultSelect = mode === 'full'
    ? `${LIST_TICKET_SELECT_FIELDS},description`
    : LIST_TICKET_SELECT_FIELDS;
  const include = input.include || (mode === 'full' ? 'description_HTML' : undefined);
  const response = await adapter.listTickets({
    ...input,
    select: input.select || defaultSelect,
    include
  });

  const items = Array.isArray(response.data && response.data.items) ? response.data.items : [];
  const itemCountValue = Number(response.data && response.data.itemCount);

  return {
    data: {
      mode,
      itemCount: Number.isFinite(itemCountValue) ? itemCountValue : items.length,
      items: items.map((ticket) => toTicketShape(ticket, input.timezone, mode)),
      continuationToken: (response.meta && response.meta.continuationToken) || null
    },
    meta: { ...(response.meta || {}) }
  };
}

async function getTicketForMode (adapter, input) {
  const mode = resolveMode(input);
  const include = input.include || (mode === 'full' ? 'description_HTML' : undefined);
  const ticketResponse = await adapter.getTicket({
    ...input,
    include
  });
  const ticket = ticketResponse.data && ticketResponse.data.ticket;
  const shapedTicket = toTicketShape(ticket, input.timezone, mode);

  const response = {
    data: {
      mode,
      ticket: shapedTicket
    },
    meta: { ...(ticketResponse.meta || {}) }
  };

  if (mode !== 'full') {
    return response;
  }

  const activityResponse = await adapter.getTicketActivities({
    region: input.region,
    timezone: input.timezone,
    ticketId: input.ticketId,
    continuationToken: input.continuationToken,
    limit: input.limit,
    include: 'comment_HTML'
  });

  const items = Array.isArray(activityResponse.data && activityResponse.data.items)
    ? activityResponse.data.items
    : [];
  const activityItemCount = Number(activityResponse.data && activityResponse.data.itemCount);

  response.data.activities = {
    itemCount: Number.isFinite(activityItemCount) ? activityItemCount : items.length,
    continuationToken: (activityResponse.data && activityResponse.data.continuationToken) || null,
    items: items.map((activity) => toActivityFull(activity, input.timezone))
  };
  response.meta.continuationToken = activityResponse.meta && activityResponse.meta.continuationToken;
  return response;
}

async function getTicketActivitiesForMode (adapter, input) {
  const mode = resolveMode(input);
  const include = input.include || (mode === 'full' ? 'comment_HTML' : undefined);
  const response = await adapter.getTicketActivities({
    ...input,
    include
  });
  const items = Array.isArray(response.data && response.data.items) ? response.data.items : [];
  const itemCountValue = Number(response.data && response.data.itemCount);
  const formatter = mode === 'full' ? toActivityFull : toActivitySummary;

  return {
    data: {
      ticketId: input.ticketId,
      mode,
      itemCount: Number.isFinite(itemCountValue) ? itemCountValue : items.length,
      continuationToken: (response.data && response.data.continuationToken) || null,
      items: items.map((activity) => formatter(activity, input.timezone))
    },
    meta: {
      ...response.meta,
      continuationToken: (response.meta && response.meta.continuationToken) || null
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
        return listTicketsForDisplay(adapter, input);
      case 'get_ticket':
        return getTicketForMode(adapter, input);
      case 'get_ticket_activities':
        return getTicketActivitiesForMode(adapter, input);
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
      case 'get_tags':
        return adapter.getTags(input);
      case 'get_ticket_attachments':
        return adapter.getTicketAttachments(input);
      case 'get_activity_attachments':
        return adapter.getActivityAttachments(input);
      case 'add_ticket_attachment_links':
        return adapter.addTicketAttachmentLinks(input);
      case 'validation_write_closed_ticket_comment':
        if (typeof input.requestorEmail !== 'string' || !input.requestorEmail.trim() ||
            typeof input.assigneeEmail !== 'string' || !input.assigneeEmail.trim()) {
          throw new Error('Both requestorEmail and assigneeEmail are required (non-empty) for validation_write_closed_ticket_comment to prevent writes against unintended tickets.');
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
