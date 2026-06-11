import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolDispatcher } from './dispatcher.js';

function createAdapterStub (overrides = {}) {
  return {
    listTickets: async () => ({ data: { items: [] }, meta: { statusCode: 200 } }),
    getTicket: async () => ({ data: {}, meta: { statusCode: 200 } }),
    createTicket: async () => ({ data: {}, meta: { statusCode: 200 } }),
    updateTicket: async () => ({ data: {}, meta: { statusCode: 200 } }),
    updateTicketStatus: async () => ({ data: {}, meta: { statusCode: 200 } }),
    addComment: async () => ({ data: { message: 'ok' }, meta: { statusCode: 200 } }),
    getInstance: async () => ({ data: {}, meta: { statusCode: 200 } }),
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

test('validation action uses strict Closed match before resolved-compatible fallback', async () => {
  let addCommentCalls = 0;
  const adapter = createAdapterStub({
    listTickets: async () => ({
      data: {
        items: [
          {
            id: 'resolved-ticket',
            status: 'In Progress',
            resolvedStatus: ['In Progress'],
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
    }),
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
  const adapter = createAdapterStub({
    listTickets: async () => {
      page += 1;
      if (page === 1) {
        return {
          data: {
            items: [
              {
                id: 'u1',
                status: 'Open',
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
  assert.equal(unresolved.data.items[0].id, 'u1');

  const unreadRequestor = await dispatch('find_my_tickets_with_unread_updates', {
    region: 'us',
    userEmail: 'user@example.com',
    perspective: 'requestor',
    top: 5,
    maxPages: 5
  });
  assert.equal(unreadRequestor.data.itemCount, 1);
  assert.equal(unreadRequestor.data.items[0].id, 'u3');
});
