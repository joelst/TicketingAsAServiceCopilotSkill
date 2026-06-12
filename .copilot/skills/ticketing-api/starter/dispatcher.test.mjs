import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolDispatcher } from './dispatcher.js';

function createAdapterStub (overrides = {}) {
  return {
    listTickets: async () => ({ data: { items: [] }, meta: { statusCode: 200 } }),
    getTicket: async () => ({ data: { ticket: {} }, meta: { statusCode: 200 } }),
    getTicketActivities: async () => ({ data: { items: [], itemCount: 0, continuationToken: null }, meta: { statusCode: 200, continuationToken: null } }),
    createTicket: async () => ({ data: {}, meta: { statusCode: 200 } }),
    updateTicket: async () => ({ data: {}, meta: { statusCode: 200 } }),
    updateTicketStatus: async () => ({ data: {}, meta: { statusCode: 200 } }),
    addComment: async () => ({ data: { message: 'ok' }, meta: { statusCode: 200 } }),
    getInstance: async () => ({ data: {}, meta: { statusCode: 200 } }),
    getTags: async () => ({ data: { items: [] }, meta: { statusCode: 200 } }),
    getTicketAttachments: async () => ({ data: { items: [] }, meta: { statusCode: 200 } }),
    getActivityAttachments: async () => ({ data: { items: [] }, meta: { statusCode: 200 } }),
    addTicketAttachmentLinks: async () => ({ data: { items: [] }, meta: { statusCode: 200 } }),
    request: async () => ({ data: { items: [] }, meta: { statusCode: 200 } }),
    ...overrides
  };
}

test('denied write operations are cancelled and do not call adapter write methods', async () => {
  const callCounts = { updateTicketStatus: 0, updateTicket: 0 };
  const adapter = createAdapterStub({
    updateTicketStatus: async () => {
      callCounts.updateTicketStatus += 1;
      return { data: { message: 'should not happen' }, meta: { statusCode: 200 } };
    },
    updateTicket: async () => {
      callCounts.updateTicket += 1;
      return { data: { message: 'should not happen' }, meta: { statusCode: 200 } };
    }
  });

  const dispatch = createToolDispatcher({
    apiKey: 'test-key',
    defaultRegion: 'us',
    defaultTimezone: '-5',
    adapter
  });

  const confirmationPayloads = [];
  const deny = async (payload) => {
    confirmationPayloads.push(payload);
    return false;
  };

  const statusResult = await dispatch('update_ticket_status', {
    region: 'us',
    ticketId: 'id-1',
    status: 'Closed',
    user: { id: 'u1', name: 'User', email: 'user@example.com' }
  }, { confirmAction: deny });

  const updateResult = await dispatch('update_ticket', {
    region: 'us',
    ticketId: 'id-2',
    ticket: {
      assignee: { id: 'u2', name: 'Assignee', email: 'assignee@example.com' }
    },
    user: { id: 'u1', name: 'User', email: 'user@example.com' }
  }, { confirmAction: deny });

  assert.equal(statusResult.cancelled, true);
  assert.equal(updateResult.cancelled, true);
  assert.equal(callCounts.updateTicketStatus, 0);
  assert.equal(callCounts.updateTicket, 0);

  assert.equal(confirmationPayloads.length, 2);
  assert.equal(confirmationPayloads[0].confirmationReason, 'high_impact_change');
  assert.equal(confirmationPayloads[1].confirmationReason, 'high_impact_change');
});

test('allowed write operations proceed and return adapter result', async () => {
  const adapter = createAdapterStub({
    addComment: async (input) => ({ data: { message: `commented:${input.ticketId}` }, meta: { statusCode: 200 } })
  });

  const dispatch = createToolDispatcher({
    apiKey: 'test-key',
    defaultRegion: 'us',
    adapter
  });

  const confirmationPayloads = [];
  const allow = async (payload) => {
    confirmationPayloads.push(payload);
    return true;
  };

  const result = await dispatch('add_comment', {
    region: 'us',
    ticketId: 'ticket-123',
    comment: 'hello',
    user: { id: 'u1', name: 'User', email: 'user@example.com' }
  }, { confirmAction: allow });

  assert.equal(confirmationPayloads.length, 1);
  assert.equal(confirmationPayloads[0].confirmationReason, 'write_operation');
  assert.equal(result.data.message, 'commented:ticket-123');
});

test('read operation bypasses confirmation gate', async () => {
  const adapter = createAdapterStub({
    listTickets: async () => ({ data: { items: [] }, meta: { statusCode: 200 } })
  });

  const dispatch = createToolDispatcher({
    apiKey: 'test-key',
    defaultRegion: 'us',
    adapter
  });

  let called = 0;
  const result = await dispatch('list_tickets', { region: 'us' }, {
    confirmAction: async () => {
      called += 1;
      return true;
    }
  });

  assert.equal(called, 0);
  assert.deepEqual(result.data.items, []);
});

test('list_tickets normalizes lastInteraction to requested timezone offset when provided', async () => {
  const adapter = createAdapterStub({
    listTickets: async () => ({
      data: {
        itemCount: 1,
        items: [
          {
            ticketNo: 'INC-1001',
            title: 'Printer issue',
            status: 'Open',
            priority: 'Medium',
            requestor: { name: 'Jane Requestor' },
            assignee: { name: 'Alex Assignee' },
            lastInteraction: '2026-06-11T04:00:00.000Z',
            attachments: []
          }
        ]
      },
      meta: { statusCode: 200 }
    })
  });

  const dispatch = createToolDispatcher({
    apiKey: 'test-key',
    defaultRegion: 'us',
    adapter
  });

  const result = await dispatch('list_tickets', { region: 'us', timezone: '-5' });
  assert.equal(result.data.itemCount, 1);
  assert.equal(result.data.items[0].ticketNo, 'INC-1001');
  assert.equal(result.data.items[0].lastInteraction, '2026-06-10T23:00:00.000-05:00');
  assert.equal(result.data.items[0].requestor.name, 'Jane Requestor');
  assert.equal(result.data.items[0].attachmentsCount, 0);
});

test('list_tickets normalizes explicit-offset timestamps to requested timezone', async () => {
  const adapter = createAdapterStub({
    listTickets: async () => ({
      data: {
        itemCount: 1,
        items: [
          {
            ticketNo: 'INC-1001-OFFSET',
            title: 'Offset timestamp ticket',
            status: 'Open',
            lastInteraction: '2026-06-11T04:00:00+02:00'
          }
        ]
      },
      meta: { statusCode: 200 }
    })
  });

  const dispatch = createToolDispatcher({
    apiKey: 'test-key',
    defaultRegion: 'us',
    adapter
  });

  const result = await dispatch('list_tickets', { region: 'us', timezone: '-5' });
  assert.equal(result.data.items[0].lastInteraction, '2026-06-10T21:00:00.000-05:00');
});

test('list_tickets treats timezone-less ISO timestamps as UTC before offset normalization', async () => {
  const adapter = createAdapterStub({
    listTickets: async () => ({
      data: {
        itemCount: 1,
        items: [
          {
            ticketNo: 'INC-1002',
            title: 'Naive timestamp ticket',
            status: 'Open',
            lastInteraction: '2026-06-11T01:00:00'
          }
        ]
      },
      meta: { statusCode: 200 }
    })
  });

  const dispatch = createToolDispatcher({
    apiKey: 'test-key',
    defaultRegion: 'us',
    adapter
  });

  const result = await dispatch('list_tickets', { region: 'us', timezone: '-5' });
  assert.equal(result.data.items[0].lastInteraction, '2026-06-10T20:00:00.000-05:00');
});

test('get_ticket returns stable null-shaped ticket when payload is missing', async () => {
  const adapter = createAdapterStub({
    getTicket: async () => ({
      data: { ticket: null },
      meta: { statusCode: 200 }
    })
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });
  const result = await dispatch('get_ticket', { region: 'us', ticketId: 'missing-ticket' });

  assert.equal(result.data.mode, 'summary');
  assert.equal(result.data.ticket.id, null);
  assert.equal(result.data.ticket.status, null);
  assert.equal(result.data.ticket.requestor.name, null);
  assert.equal(result.data.ticket.assignee.email, null);
  assert.deepEqual(result.data.ticket.tags, []);
  assert.equal(result.data.ticket.description.rawHtml, null);
  assert.equal(result.data.ticket.description.plainText, null);
});

test('get_ticket supports item-wrapped and direct object payloads via adapter normalization', async () => {
  const adapter = createAdapterStub({
    getTicket: async () => ({
      data: {
        ticket: {
          id: 't-1',
          ticketNo: 1001,
          title: 'VPN access',
          status: 'Open',
          requestor: { id: 'r1', name: 'R User', email: 'r@example.com' },
          assignee: { id: 'a1', name: 'A User', email: 'a@example.com' },
          createdOn: '2026-06-11T01:00:00.000Z',
          lastUpdatedOn: '2026-06-11T02:00:00.000Z',
          tags: []
        }
      },
      meta: { statusCode: 200 }
    })
  });
  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });
  const result = await dispatch('get_ticket', { region: 'us', ticketId: 't-1', timezone: '-5' });

  assert.equal(result.data.mode, 'summary');
  assert.equal(result.data.ticket.id, 't-1');
  assert.equal(result.data.ticket.ticketNo, 1001);
  assert.equal(result.data.ticket.createdOn, '2026-06-10T20:00:00.000-05:00');
  assert.equal(result.data.ticket.updatedOn, '2026-06-10T21:00:00.000-05:00');
  assert.equal(result.data.ticket.attachmentsCount, null);
  assert.equal(result.data.ticket.activityCount, null);
  assert.equal(result.data.ticket.description.rawHtml, null);
});

test('get_ticket_activities supports full mode with action typing, changes, and continuation token', async () => {
  const adapter = createAdapterStub({
    getTicketActivities: async () => ({
      data: {
        items: [
          {
            id: 'act-1',
            action: 'Start Ticket',
            createdDateTime: '2026-06-11T03:00:00.000Z',
            createdBy: { id: 'u1', name: 'Agent', email: 'agent@example.com' },
            comment: '<p>Started work</p>',
            changes: [{ name: 'status', oldValue: 'Open', newValue: 'Started' }],
            attachments: [{ id: 'att-1', filename: 'screenshot.png', src: 'https://example.test/screenshot.png' }]
          }
        ],
        itemCount: 1,
        continuationToken: 'next-page'
      },
      meta: { statusCode: 200, continuationToken: 'next-page' }
    })
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });
  const result = await dispatch('get_ticket_activities', {
    region: 'us',
    ticketId: 't-1',
    mode: 'full',
    timezone: '-5'
  });

  assert.equal(result.data.mode, 'full');
  assert.equal(result.data.continuationToken, 'next-page');
  assert.equal(result.meta.continuationToken, 'next-page');
  assert.equal(result.data.items[0].action, 'started');
  assert.equal(result.data.items[0].changes[0].field, 'status');
  assert.equal(result.data.items[0].comment.rawHtml, '<p>Started work</p>');
  assert.equal(result.data.items[0].comment.plainText, 'Started work');
  assert.equal(result.data.items[0].timestamp, '2026-06-10T22:00:00.000-05:00');
  assert.equal(result.data.items[0].user.name, 'Agent');
  assert.equal(result.data.items[0].attachments[0].name, 'screenshot.png');
});

test('get_ticket full mode keeps ticket activityCount separate from fetched activity page count', async () => {
  const adapter = createAdapterStub({
    getTicket: async () => ({
      data: {
        ticket: {
          id: 't-1',
          ticketNo: 1001,
          title: 'VPN access',
          status: 'Open',
          requestor: { name: 'R User' },
          assignee: { name: 'A User' },
          activityCount: 12
        }
      },
      meta: { statusCode: 200 }
    }),
    getTicketActivities: async () => ({
      data: {
        items: [
          {
            id: 'act-1',
            comment: '<p>First visible activity page item</p>',
            createdDateTime: '2026-06-11T03:00:00.000Z',
            createdBy: 'Agent'
          }
        ],
        itemCount: 1,
        continuationToken: 'next-page'
      },
      meta: { statusCode: 200, continuationToken: 'next-page' }
    })
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });
  const result = await dispatch('get_ticket', {
    region: 'us',
    ticketId: 't-1',
    mode: 'full',
    timezone: '-5'
  });

  assert.equal(result.data.ticket.activityCount, 12);
  assert.equal(result.data.activities.itemCount, 1);
  assert.equal(result.data.activities.continuationToken, 'next-page');
  assert.equal(result.data.activities.items[0].action, 'commented');
  assert.equal(result.data.activities.items[0].user.name, 'Agent');
});

test('get_ticket uses explicit mode only and ignores non-schema hint fields', async () => {
  let activitiesCalls = 0;
  const adapter = createAdapterStub({
    getTicket: async () => ({
      data: {
        ticket: {
          id: 't-1',
          ticketNo: 1001,
          title: 'VPN access',
          status: 'Open'
        }
      },
      meta: { statusCode: 200 }
    }),
    getTicketActivities: async () => {
      activitiesCalls += 1;
      return {
        data: { items: [], itemCount: 0, continuationToken: null },
        meta: { statusCode: 200, continuationToken: null }
      };
    }
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });

  const byHintOnly = await dispatch('get_ticket', { region: 'us', ticketId: 't-1', details: true });
  assert.equal(byHintOnly.data.mode, 'summary');
  assert.ok(!Object.prototype.hasOwnProperty.call(byHintOnly.data, 'activities'));

  const byExplicitMode = await dispatch('get_ticket', { region: 'us', ticketId: 't-1', mode: 'full' });
  assert.equal(byExplicitMode.data.mode, 'full');
  assert.ok(Object.prototype.hasOwnProperty.call(byExplicitMode.data, 'activities'));

  assert.equal(activitiesCalls, 1);
});

test('get_ticket full mode leaves unknown ticket activityCount as null', async () => {
  const adapter = createAdapterStub({
    getTicket: async () => ({
      data: {
        ticket: {
          id: 't-1',
          ticketNo: 1001,
          title: 'VPN access',
          status: 'Open'
        }
      },
      meta: { statusCode: 200 }
    }),
    getTicketActivities: async () => ({
      data: {
        items: [{ id: 'act-1', comment: 'Visible page item' }],
        itemCount: 1,
        continuationToken: null
      },
      meta: { statusCode: 200, continuationToken: null }
    })
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });
  const result = await dispatch('get_ticket', {
    region: 'us',
    ticketId: 't-1',
    mode: 'full'
  });

  assert.equal(result.data.ticket.activityCount, null);
  assert.equal(result.data.activities.itemCount, 1);
});

test('validation action uses strict Closed match before resolved-compatible fallback', async () => {
  let addCommentCalls = 0;
  let listTicketsInput = null;
  const adapter = createAdapterStub({
    listTickets: async (input) => {
      listTicketsInput = input;
      return {
        data: {
          items: [
            {
              id: 'resolved-ticket',
              status: 'In Progress',
              requestor: { email: 'requestor@example.com' },
              assignee: { id: 'a1', name: 'Assignee', email: 'assignee@example.com' }
            },
            {
              id: 'closed-ticket',
              status: 'Closed',
              requestor: { email: 'requestor@example.com' },
              assignee: { id: 'a2', name: 'Assignee', email: 'assignee@example.com' }
            }
          ]
        },
        meta: { statusCode: 200 }
      };
    },
    addComment: async (input) => {
      addCommentCalls += 1;
      return { data: { message: `commented:${input.ticketId}` }, meta: { statusCode: 200 } };
    },
    request: async () => ({ data: { items: [{ comment: 'c1' }] }, meta: { statusCode: 200 } })
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });
  const result = await dispatch('validation_write_closed_ticket_comment', {
    region: 'us',
    assigneeEmail: 'Assignee@Example.com',
    requestorEmail: 'REQUESTOR@example.com',
    comment: 'c1'
  }, { confirmAction: async () => true });

  assert.equal(addCommentCalls, 1);
  assert.equal(result.data.targetTicketId, 'closed-ticket');
  assert.equal(
    listTicketsInput.select,
    'id,ticketNo,title,priority,status,requestor,assignee,firstResolutionOn,lastResolutionOn'
  );
});

test('validation action fallback can be disabled and then throws when no Closed ticket exists', async () => {
  const adapter = createAdapterStub({
    listTickets: async () => ({
      data: {
        items: [
          {
            id: 'resolved-only',
            status: 'Resolved',
            requestor: { email: 'requestor@example.com' },
            assignee: { id: 'a1', name: 'Assignee', email: 'assignee@example.com' }
          }
        ]
      },
      meta: { statusCode: 200 }
    })
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });
  await assert.rejects(
    dispatch('validation_write_closed_ticket_comment', {
      region: 'us',
      assigneeEmail: 'assignee@example.com',
      requestorEmail: 'requestor@example.com',
      allowResolvedFallback: false
    }, { confirmAction: async () => true }),
    /No qualifying ticket found/
  );
});

test('validation action honors stopOnFirstMatch=false and continues paging after first match', async () => {
  let listCalls = 0;
  const adapter = createAdapterStub({
    listTickets: async () => {
      listCalls += 1;
      if (listCalls === 1) {
        return {
          data: {
            items: [
              {
                id: 'closed-page-1',
                status: 'Closed',
                requestor: { email: 'requestor@example.com' },
                assignee: { id: 'a1', name: 'Assignee', email: 'assignee@example.com' }
              }
            ]
          },
          meta: { statusCode: 200, continuationToken: 'next' }
        };
      }

      return {
        data: {
          items: [
            {
              id: 'closed-page-2',
              status: 'Closed',
              requestor: { email: 'requestor@example.com' },
              assignee: { id: 'a2', name: 'Assignee', email: 'assignee@example.com' }
            }
          ]
        },
        meta: { statusCode: 200 }
      };
    },
    addComment: async (input) => ({ data: { message: `commented:${input.ticketId}` }, meta: { statusCode: 200 } }),
    request: async () => ({ data: { items: [{ comment: 'c1' }] }, meta: { statusCode: 200 } })
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });
  const result = await dispatch('validation_write_closed_ticket_comment', {
    region: 'us',
    assigneeEmail: 'assignee@example.com',
    requestorEmail: 'requestor@example.com',
    stopOnFirstMatch: false,
    comment: 'c1',
    maxPages: 2,
    limit: 1
  }, { confirmAction: async () => true });

  assert.equal(listCalls, 2);
  assert.equal(result.data.targetTicketId, 'closed-page-1');
});

test('practical tools filter by perspective, unseen counters, top clipping, and pagination', async () => {
  let page = 0;
  const listSelects = [];
  const adapter = createAdapterStub({
    listTickets: async (input) => {
      listSelects.push(input.select);
      page += 1;
      if (page === 1) {
        return {
          data: {
            items: [
              {
                id: 'u1',
                status: 'Open',
                firstResolutionOn: null,
                lastResolutionOn: null,
                assignee: { email: 'user@example.com' },
                requestor: { email: 'other@example.com' },
                assigneeUnseenEventCnt: 2,
                requestorUnseenEventCnt: 0
              },
              {
                id: 'u2',
                status: 'Closed',
                assignee: { email: 'user@example.com' },
                requestor: { email: 'other@example.com' },
                assigneeUnseenEventCnt: 1,
                requestorUnseenEventCnt: 0
              }
            ]
          },
          meta: { statusCode: 200, continuationToken: 'next' }
        };
      }

      return {
        data: {
          items: [
            {
              id: 'u3',
              status: 'Open',
              assignee: { email: 'other@example.com' },
              requestor: { email: 'user@example.com' },
              assigneeUnseenEventCnt: 0,
              requestorUnseenEventCnt: 4
            }
          ]
        },
        meta: { statusCode: 200 }
      };
    }
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter, currentUserEmail: 'user@example.com' });

  const unresolved = await dispatch('find_my_unresolved_tickets', {
    region: 'us',
    perspective: 'assignee',
    top: 1,
    maxPages: 5
  });
  assert.equal(unresolved.data.itemCount, 1);
  assert.equal(unresolved.data.items[0].ticketNo, null);
  assert.equal(unresolved.data.items[0].requestor.name, null);
  assert.equal(unresolved.data.items[0].status, 'Open');
  assert.equal(unresolved.data.items[0].assignee.id, null);
  assert.equal(unresolved.data.items[0].unseenUpdates.assignee, 2);
  assert.equal(unresolved.data.items[0].unseenUpdates.requestor, 0);
  assert.equal(unresolved.data.items[0].resolvedStatus, null);
  assert.equal(unresolved.data.items[0].firstResolutionOn, null);
  assert.equal(unresolved.data.items[0].lastResolutionOn, null);

  const unreadRequestor = await dispatch('find_my_tickets_with_unread_updates', {
    region: 'us',
    userEmail: 'user@example.com',
    perspective: 'requestor',
    top: 5,
    maxPages: 5
  });
  assert.equal(unreadRequestor.data.itemCount, 1);
  assert.equal(unreadRequestor.data.items[0].status, 'Open');
  assert.equal(unreadRequestor.data.items[0].requestor.email, 'user@example.com');
  assert.equal(unreadRequestor.data.items[0].unseenUpdates.assignee, 0);
  assert.equal(unreadRequestor.data.items[0].unseenUpdates.requestor, 4);
  assert.ok(listSelects.every((select) => !String(select || '').includes('resolvedStatus')));
});

test('list_tickets with mode=full includes description in select; mode=summary does not', async () => {
  const selects = [];
  const adapter = createAdapterStub({
    listTickets: async (input) => {
      selects.push(input.select);
      return { data: { items: [] }, meta: { statusCode: 200 } };
    }
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });

  await dispatch('list_tickets', { region: 'us', mode: 'full' });
  await dispatch('list_tickets', { region: 'us', mode: 'summary' });
  await dispatch('list_tickets', { region: 'us' });

  assert.ok(String(selects[0]).includes('description'), 'mode=full select should include description');
  assert.ok(!String(selects[1]).includes('description'), 'mode=summary select should not include description');
  assert.ok(!String(selects[2]).includes('description'), 'default mode select should not include description');
});

test('read-only tag and attachment tools route to their adapter methods and bypass the gate', async () => {
  const calls = [];
  const adapter = createAdapterStub({
    getTags: async (input) => { calls.push(['getTags', input]); return { data: { items: [] }, meta: { statusCode: 200 } }; },
    getTicketAttachments: async (input) => { calls.push(['getTicketAttachments', input]); return { data: { items: [] }, meta: { statusCode: 200 } }; },
    getActivityAttachments: async (input) => { calls.push(['getActivityAttachments', input]); return { data: { items: [] }, meta: { statusCode: 200 } }; }
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });

  let confirmCalls = 0;
  const confirmSpy = async () => { confirmCalls += 1; return true; };

  await dispatch('get_tags', { region: 'us', timezone: '-5' }, { confirmAction: confirmSpy });
  await dispatch('get_ticket_attachments', { region: 'us', ticketId: 't-1', timezone: '-5' }, { confirmAction: confirmSpy });
  await dispatch('get_activity_attachments', { region: 'us', activityId: 'a-1', timezone: '-5' }, { confirmAction: confirmSpy });

  assert.deepEqual(calls.map((c) => c[0]), ['getTags', 'getTicketAttachments', 'getActivityAttachments']);
  assert.equal(calls[0][1].region, 'us');
  assert.equal(calls[1][1].ticketId, 't-1');
  assert.equal(calls[2][1].activityId, 'a-1');
  assert.equal(confirmCalls, 0, 'read-only tools must not call the confirmation gate');
});

test('add_ticket_attachment_links is gated, routes to adapter when confirmed', async () => {
  let addCalls = 0;
  let capturedInput = null;
  const adapter = createAdapterStub({
    addTicketAttachmentLinks: async (input) => {
      addCalls += 1;
      capturedInput = input;
      return { data: { items: [{ activityId: 'act-99' }] }, meta: { statusCode: 200 } };
    }
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });

  const payloads = [];
  const result = await dispatch('add_ticket_attachment_links', {
    region: 'us',
    ticketId: 't-1',
    attachments: [{ src: 'https://example.test/a.png', caption: 'a' }],
    user: { id: 'u1', name: 'User', email: 'user@example.com' }
  }, { confirmAction: async (payload) => { payloads.push(payload); return true; } });

  assert.equal(addCalls, 1);
  assert.equal(capturedInput.ticketId, 't-1');
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].confirmationReason, 'write_operation');
  assert.equal(result.data.items[0].activityId, 'act-99');
});

test('add_ticket_attachment_links is cancelled and does not call adapter when denied', async () => {
  let addCalls = 0;
  const adapter = createAdapterStub({
    addTicketAttachmentLinks: async () => {
      addCalls += 1;
      return { data: {}, meta: { statusCode: 200 } };
    }
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });

  const result = await dispatch('add_ticket_attachment_links', {
    region: 'us',
    ticketId: 't-1',
    attachments: [{ src: 'https://example.test/a.png', caption: 'a' }],
    user: { id: 'u1', name: 'User', email: 'user@example.com' }
  }, { confirmAction: async () => false });

  assert.equal(result.cancelled, true);
  assert.equal(addCalls, 0);
});

test('get_ticket preserves resolvedStatus as an array (verified live shape) and nulls non-arrays', async () => {
  const adapterArray = createAdapterStub({
    getTicket: async () => ({
      data: { ticket: { id: 't-1', status: 'Closed', resolvedStatus: ['Resolved', 'Closed'] } },
      meta: { statusCode: 200 }
    })
  });
  const dispatchArray = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter: adapterArray });
  const arrResult = await dispatchArray('get_ticket', { region: 'us', ticketId: 't-1' });
  assert.deepEqual(arrResult.data.ticket.resolvedStatus, ['Resolved', 'Closed']);

  const adapterString = createAdapterStub({
    getTicket: async () => ({
      data: { ticket: { id: 't-2', status: 'Closed', resolvedStatus: 'fixed' } },
      meta: { statusCode: 200 }
    })
  });
  const dispatchString = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter: adapterString });
  const strResult = await dispatchString('get_ticket', { region: 'us', ticketId: 't-2' });
  assert.equal(strResult.data.ticket.resolvedStatus, null);
});

test('get_ticket_activities surfaces isPrivate on shaped activities (true/false/absent)', async () => {
  const adapter = createAdapterStub({
    getTicketActivities: async () => ({
      data: {
        items: [
          { id: 'a1', comment: 'internal', isPrivate: true },
          { id: 'a2', comment: 'public', isPrivate: false },
          { id: 'a3', comment: 'legacy' }
        ],
        itemCount: 3,
        continuationToken: null
      },
      meta: { statusCode: 200, continuationToken: null }
    })
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });
  const result = await dispatch('get_ticket_activities', { region: 'us', ticketId: 't-1', mode: 'full' });

  assert.equal(result.data.items[0].isPrivate, true);
  assert.equal(result.data.items[1].isPrivate, false);
  assert.equal(result.data.items[2].isPrivate, null);
});

test('get_ticket_activities summary mode surfaces isPrivate via toActivitySummary', async () => {
  const adapter = createAdapterStub({
    getTicketActivities: async () => ({
      data: {
        items: [
          { id: 'a1', comment: 'internal', isPrivate: true },
          { id: 'a2', comment: 'public', isPrivate: false },
          { id: 'a3', comment: 'legacy' }
        ],
        itemCount: 3,
        continuationToken: null
      },
      meta: { statusCode: 200, continuationToken: null }
    })
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });
  const result = await dispatch('get_ticket_activities', { region: 'us', ticketId: 't-1' });

  assert.equal(result.data.mode, 'summary');
  assert.equal(result.data.items[0].isPrivate, true);
  assert.equal(result.data.items[1].isPrivate, false);
  assert.equal(result.data.items[2].isPrivate, null);
});

test('get_ticket full mode embeds activities with isPrivate shaped', async () => {
  const adapter = createAdapterStub({
    getTicket: async () => ({ data: { ticket: { id: 't-1', status: 'Open' } }, meta: { statusCode: 200 } }),
    getTicketActivities: async () => ({
      data: {
        items: [
          { id: 'a1', comment: 'internal', isPrivate: true },
          { id: 'a2', comment: 'legacy' }
        ],
        itemCount: 2,
        continuationToken: null
      },
      meta: { statusCode: 200, continuationToken: null }
    })
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });
  const result = await dispatch('get_ticket', { region: 'us', ticketId: 't-1', mode: 'full' });

  assert.equal(result.data.activities.items[0].isPrivate, true);
  assert.equal(result.data.activities.items[1].isPrivate, null);
});

test('add_comment forwards isPrivate to adapter.addComment', async () => {
  const captured = [];
  const adapter = createAdapterStub({
    addComment: async (input) => {
      captured.push(input);
      return { data: { message: 'ok' }, meta: { statusCode: 200 } };
    }
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter });

  await dispatch('add_comment', {
    region: 'us', ticketId: 't-1', comment: 'internal',
    user: { id: 'u1', name: 'U', email: 'u@e.com' }, isPrivate: true
  }, { confirmAction: async () => true });

  await dispatch('add_comment', {
    region: 'us', ticketId: 't-1', comment: 'public',
    user: { id: 'u1', name: 'U', email: 'u@e.com' }
  }, { confirmAction: async () => true });

  assert.equal(captured[0].isPrivate, true);
  // The dispatcher forwards input verbatim; the false default for an omitted flag is
  // applied in adapter.addComment (covered in adapter.test.mjs), so it arrives undefined here.
  assert.equal(captured[1].isPrivate, undefined);
});

test('find_my_unresolved_tickets classifies custom statuses by resolvedStatus array membership', async () => {
  const adapter = createAdapterStub({
    listTickets: async () => ({
      data: {
        items: [
          // Custom status that IS in its resolvedStatus set -> resolved -> excluded.
          { id: 'done', status: 'Done', assignee: { email: 'user@example.com' }, resolvedStatus: ['Done', 'Closed'] },
          // Custom status NOT in its resolvedStatus set -> unresolved -> included.
          { id: 'inprog', status: 'In Progress', assignee: { email: 'user@example.com' }, resolvedStatus: ['Resolved', 'Closed'] }
        ]
      },
      meta: { statusCode: 200 }
    })
  });

  const dispatch = createToolDispatcher({ apiKey: 'test-key', defaultRegion: 'us', adapter, currentUserEmail: 'user@example.com' });
  const result = await dispatch('find_my_unresolved_tickets', { region: 'us', perspective: 'assignee', top: 25, maxPages: 1 });

  assert.equal(result.data.itemCount, 1);
  assert.equal(result.data.items[0].status, 'In Progress');
  assert.deepEqual(result.data.items[0].resolvedStatus, ['Resolved', 'Closed']);
});
