import test from 'node:test';
import assert from 'node:assert/strict';
import { TicketingApiAdapter, TicketingApiError } from './adapter.js';

function createJsonResponse (status, body, headers = {}) {
  const normalizedHeaders = new Headers(headers);
  return new Response(JSON.stringify(body), {
    status,
    headers: normalizedHeaders
  });
}

function createAdapterWithQueue (queue, maxRetries = 1) {
  let calls = 0;
  const sleepCalls = [];

  const adapter = new TicketingApiAdapter({
    apiKey: 'secret-key',
    defaultRegion: 'us',
    maxRetries,
    fetchImpl: async () => {
      const next = queue[calls];
      calls += 1;
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
    sleepImpl: async (ms) => {
      sleepCalls.push(ms);
    }
  });

  return {
    adapter,
    getCallCount: () => calls,
    sleepCalls
  };
}

test('retries on 429 and succeeds before maxRetries', async () => {
  const { adapter, getCallCount, sleepCalls } = createAdapterWithQueue([
    createJsonResponse(429, { message: 'rate limited' }),
    createJsonResponse(200, { items: [] })
  ], 2);

  const result = await adapter.request({
    region: 'us',
    method: 'GET',
    path: '/tickets'
  });

  assert.equal(getCallCount(), 2);
  assert.equal(result.meta.retryCount, 1);
  assert.deepEqual(result.data, { items: [] });
  assert.equal(sleepCalls.length, 1);
});

test('throws Error instance with canonical metadata after max retries on 5xx', async () => {
  const { adapter, getCallCount, sleepCalls } = createAdapterWithQueue([
    createJsonResponse(503, { message: 'temporary upstream failure' }),
    createJsonResponse(503, { message: 'temporary upstream failure' })
  ], 1);

  await assert.rejects(
    adapter.request({
      region: 'us',
      method: 'GET',
      path: '/tickets'
    }),
    (error) => {
      assert.equal(getCallCount(), 2);
      assert.ok(error instanceof Error);
      assert.ok(error instanceof TicketingApiError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.canonicalType, 'upstream_error');
      assert.equal(error.retryable, true);
      assert.equal(typeof error.meta.retryCount, 'number');
      return true;
    }
  );

  assert.equal(sleepCalls.length, 1);
});

test('retries network failures and returns redacted terminal error', async () => {
  const { adapter, getCallCount, sleepCalls } = createAdapterWithQueue([
    new Error('request failed for https://example/api?key=supersecret&x=1'),
    new Error('request failed for https://example/api?key=supersecret&x=1')
  ], 1);

  await assert.rejects(
    adapter.request({
      region: 'us',
      method: 'GET',
      path: '/tickets'
    }),
    (error) => {
      assert.equal(getCallCount(), 2);
      assert.ok(error instanceof Error);
      assert.equal(error.statusCode, 0);
      assert.equal(error.retryable, true);
      assert.match(error.message, /key=\[REDACTED\]/i);
      assert.doesNotMatch(error.message, /supersecret/i);
      return true;
    }
  );

  assert.equal(sleepCalls.length, 1);
});

test('redacts sensitive key values from upstream response messages', async () => {
  const { adapter } = createAdapterWithQueue([
    createJsonResponse(400, {
      message: 'bad request: https://service/api?key=abc123&token=qwerty'
    })
  ], 0);

  await assert.rejects(
    adapter.request({
      region: 'us',
      method: 'GET',
      path: '/tickets'
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.statusCode, 400);
      assert.equal(error.canonicalType, 'validation_error');
      assert.match(error.message, /key=\[REDACTED\]/i);
      assert.match(error.message, /token=\[REDACTED\]/i);
      assert.doesNotMatch(error.message, /abc123|qwerty/i);
      assert.equal(error.apiMessage, error.message);
      return true;
    }
  );
});

test('maps 401 to auth_error and marks it non-retryable', async () => {
  const { adapter, getCallCount, sleepCalls } = createAdapterWithQueue([
    createJsonResponse(401, { message: 'unauthorized' })
  ], 2);

  await assert.rejects(
    adapter.request({
      region: 'us',
      method: 'GET',
      path: '/tickets'
    }),
    (error) => {
      assert.equal(getCallCount(), 1);
      assert.ok(error instanceof TicketingApiError);
      assert.equal(error.statusCode, 401);
      assert.equal(error.canonicalType, 'auth_error');
      assert.equal(error.retryable, false);
      return true;
    }
  );

  assert.equal(sleepCalls.length, 0);
});

test('maps 404 to not_found and marks it non-retryable', async () => {
  const { adapter, getCallCount, sleepCalls } = createAdapterWithQueue([
    createJsonResponse(404, { message: 'ticket not found' })
  ], 2);

  await assert.rejects(
    adapter.request({
      region: 'us',
      method: 'GET',
      path: '/tickets/does-not-exist'
    }),
    (error) => {
      assert.equal(getCallCount(), 1);
      assert.ok(error instanceof TicketingApiError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.canonicalType, 'not_found');
      assert.equal(error.retryable, false);
      return true;
    }
  );

  assert.equal(sleepCalls.length, 0);
});

test('maps 403 to forbidden and marks it non-retryable', async () => {
  const { adapter, getCallCount, sleepCalls } = createAdapterWithQueue([
    createJsonResponse(403, { message: 'forbidden' })
  ], 2);

  await assert.rejects(
    adapter.request({
      region: 'us',
      method: 'PUT',
      path: '/tickets/abc/status'
    }),
    (error) => {
      assert.equal(getCallCount(), 1);
      assert.ok(error instanceof TicketingApiError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.canonicalType, 'forbidden');
      assert.equal(error.retryable, false);
      return true;
    }
  );

  assert.equal(sleepCalls.length, 0);
});

test('sends key as query param and does not send Ocp-Apim-Subscription-Key header', async () => {
  let capturedUrl;
  let capturedHeaders;
  const { adapter } = createAdapterWithQueue([
    createJsonResponse(200, { items: [] })
  ], 0);

  const originalFetch = adapter.fetchImpl;
  adapter.fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedHeaders = init.headers;
    return originalFetch(url, init);
  };

  await adapter.request({ region: 'us', method: 'GET', path: '/tickets' });

  assert.equal(capturedUrl.searchParams.get('key'), 'secret-key');
  assert.equal(Object.prototype.hasOwnProperty.call(capturedHeaders, 'Ocp-Apim-Subscription-Key'), false);
});

test('does not set Content-Type for GET requests without body and sets Accept', async () => {
  let capturedInit;
  const { adapter } = createAdapterWithQueue([
    createJsonResponse(200, { items: [] })
  ], 0);

  const originalFetch = adapter.fetchImpl;
  adapter.fetchImpl = async (_url, init) => {
    capturedInit = init;
    return originalFetch(_url, init);
  };

  await adapter.request({
    region: 'us',
    method: 'GET',
    path: '/tickets'
  });

  assert.equal(capturedInit.headers.Accept, 'application/json');
  assert.equal(Object.prototype.hasOwnProperty.call(capturedInit.headers, 'Content-Type'), false);
});

test('updateTicketStatus normalizes human-friendly resolution to the API enum', async () => {
  let capturedBody;
  const { adapter } = createAdapterWithQueue([
    createJsonResponse(200, { ok: true })
  ], 0);

  const originalFetch = adapter.fetchImpl;
  adapter.fetchImpl = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return originalFetch(_url, init);
  };

  await adapter.updateTicketStatus({
    region: 'us',
    ticketId: 'abc',
    status: 'Closed',
    resolution: 'Fixed',
    comment: 'deployed patch',
    user: { id: '1', name: 'Agent', email: 'agent@example.com' }
  });

  assert.equal(capturedBody.resolution, 'fixed');
});

test('updateTicketStatus passes through unknown resolution values unchanged', async () => {
  let capturedBody;
  const { adapter } = createAdapterWithQueue([
    createJsonResponse(200, { ok: true })
  ], 0);

  const originalFetch = adapter.fetchImpl;
  adapter.fetchImpl = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return originalFetch(_url, init);
  };

  await adapter.updateTicketStatus({
    region: 'us',
    ticketId: 'abc',
    status: 'Closed',
    resolution: 'customWorkflowOutcome',
    user: { id: '1', name: 'Agent', email: 'agent@example.com' }
  });

  assert.equal(capturedBody.resolution, 'customWorkflowOutcome');
});

test('getTicket normalizes direct object payload to data.ticket', async () => {
  const { adapter } = createAdapterWithQueue([
    createJsonResponse(200, { id: 't1', ticketNo: 'INC-1', title: 'Issue' })
  ], 0);

  const result = await adapter.getTicket({
    region: 'us',
    ticketId: 't1'
  });

  assert.equal(result.data.ticket.id, 't1');
  assert.equal(result.data.ticket.ticketNo, 'INC-1');
});

test('getTicket unwraps ticket-wrapped payload to data.ticket', async () => {
  const { adapter } = createAdapterWithQueue([
    createJsonResponse(200, {
      ticket: { id: 't2', ticketNo: 1002, title: 'Wrapped issue' }
    })
  ], 0);

  const result = await adapter.getTicket({
    region: 'us',
    ticketId: 't2'
  });

  assert.equal(result.data.ticket.id, 't2');
  assert.equal(result.data.ticket.ticketNo, 1002);
  assert.equal(result.data.ticket.title, 'Wrapped issue');
});

test('getTicketActivities returns continuationToken from body when header is absent', async () => {
  const { adapter } = createAdapterWithQueue([
    createJsonResponse(200, {
      items: [{ id: 'a1', action: 'commented' }],
      itemCount: 1,
      continuationToken: 'body-token'
    })
  ], 0);

  const result = await adapter.getTicketActivities({
    region: 'us',
    ticketId: 't1',
    limit: 50
  });

  assert.equal(result.data.itemCount, 1);
  assert.equal(result.data.continuationToken, 'body-token');
  assert.equal(result.meta.continuationToken, 'body-token');
});

test('listTickets normalizes body continuationToken into data and meta', async () => {
  const { adapter } = createAdapterWithQueue([
    createJsonResponse(200, {
      items: [{ id: 't1', ticketNo: 1001 }],
      continuationToken: 'ticket-body-token'
    })
  ], 0);

  const result = await adapter.listTickets({
    region: 'us',
    limit: 50
  });

  assert.equal(result.data.itemCount, 1);
  assert.equal(result.data.continuationToken, 'ticket-body-token');
  assert.equal(result.meta.continuationToken, 'ticket-body-token');
});

function captureRequest (adapter) {
  const captured = {};
  const originalFetch = adapter.fetchImpl;
  adapter.fetchImpl = async (url, init) => {
    captured.url = url;
    captured.init = init;
    return originalFetch(url, init);
  };
  return captured;
}

test('getTags issues GET /tags with timezone and key query params', async () => {
  const { adapter } = createAdapterWithQueue([createJsonResponse(200, { items: [] })], 0);
  const captured = captureRequest(adapter);

  await adapter.getTags({ region: 'us', timezone: '-5' });

  assert.equal(captured.init.method, 'GET');
  assert.ok(captured.url.pathname.endsWith('/tags'));
  assert.equal(captured.url.searchParams.get('timezone'), '-5');
  assert.equal(captured.url.searchParams.get('key'), 'secret-key');
  assert.equal(Object.prototype.hasOwnProperty.call(captured.init.headers, 'Content-Type'), false);
});

test('getTicketAttachments issues GET /tickets/{ticketId}/attachments with encoded id', async () => {
  const { adapter } = createAdapterWithQueue([createJsonResponse(200, { items: [] })], 0);
  const captured = captureRequest(adapter);

  await adapter.getTicketAttachments({ region: 'us', ticketId: 't 1', timezone: '-5' });

  assert.equal(captured.init.method, 'GET');
  assert.ok(captured.url.pathname.endsWith('/tickets/t%201/attachments'));
  assert.equal(captured.url.searchParams.get('timezone'), '-5');
});

test('getActivityAttachments issues GET /tickets/activity/{activityId}/attachments', async () => {
  const { adapter } = createAdapterWithQueue([createJsonResponse(200, { items: [] })], 0);
  const captured = captureRequest(adapter);

  await adapter.getActivityAttachments({ region: 'us', activityId: 'act-1', timezone: '-5' });

  assert.equal(captured.init.method, 'GET');
  assert.ok(captured.url.pathname.endsWith('/tickets/activity/act-1/attachments'));
  assert.equal(captured.url.searchParams.get('timezone'), '-5');
});

test('addTicketAttachmentLinks POSTs attachments and defaults isPrivate to false', async () => {
  const { adapter } = createAdapterWithQueue([createJsonResponse(200, { items: [{ activityId: 'act-1' }] })], 0);
  const captured = captureRequest(adapter);

  await adapter.addTicketAttachmentLinks({
    region: 'us',
    ticketId: 't-1',
    timezone: '-5',
    comment: 'see attached',
    attachments: [{ src: 'https://example.test/a.png', caption: 'a' }],
    user: { id: 'u1', name: 'User', email: 'user@example.com' }
  });

  assert.equal(captured.init.method, 'POST');
  assert.ok(captured.url.pathname.endsWith('/tickets/t-1/attachments'));
  assert.equal(captured.url.searchParams.get('timezone'), '-5');
  assert.equal(captured.init.headers['Content-Type'], 'application/json');

  const body = JSON.parse(captured.init.body);
  assert.equal(body.comment, 'see attached');
  assert.deepEqual(body.attachments, [{ src: 'https://example.test/a.png', caption: 'a' }]);
  assert.equal(body.user.email, 'user@example.com');
  assert.equal(body.isPrivate, false);
});

test('addTicketAttachmentLinks preserves explicit isPrivate=true', async () => {
  const { adapter } = createAdapterWithQueue([createJsonResponse(200, { items: [] })], 0);
  const captured = captureRequest(adapter);

  await adapter.addTicketAttachmentLinks({
    region: 'us',
    ticketId: 't-1',
    attachments: [{ src: 'https://example.test/a.png' }],
    user: { id: 'u1', name: 'User', email: 'user@example.com' },
    isPrivate: true
  });

  const body = JSON.parse(captured.init.body);
  assert.equal(body.isPrivate, true);
});

test('request sends numeric timezone 0 (UTC) instead of dropping it as falsy', async () => {
  const { adapter } = createAdapterWithQueue([createJsonResponse(200, { items: [] })], 0);
  const captured = captureRequest(adapter);

  await adapter.request({ region: 'us', method: 'GET', path: '/tickets', query: { timezone: 0 } });

  assert.equal(captured.url.searchParams.get('timezone'), '0');
});
