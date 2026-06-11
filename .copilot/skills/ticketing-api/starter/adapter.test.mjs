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
