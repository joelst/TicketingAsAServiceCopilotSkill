const REGION_HOSTS = {
  us: 'https://teamswork.azure-api.net',
  eu: 'https://ticketing-apim-eu.azure-api.net',
  apac: 'https://ticketing-apim-aus.azure-api.net'
};

const BASE_PATH = '/ticketing/v1';

export class TicketingApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TicketingApiError';
    this.apiMessage = message;
    this.statusCode = details.statusCode;
    this.canonicalType = details.canonicalType;
    this.retryable = details.retryable;
    this.meta = details.meta;
    this.cause = details.cause;
  }
}

function redactSensitiveQueryValues (message) {
  if (typeof message !== 'string' || message.length === 0) {
    return message;
  }

  return message
    .replace(/([?&]key=)[^&\s]+/ig, '$1[REDACTED]')
    .replace(/([?&](?:sig|signature|token|access_token)=)[^&\s]+/ig, '$1[REDACTED]');
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RESOLUTION_ALIASES = new Map([
  ['fixed', 'fixed'],
  ['cannotresolve', 'cannotResolve'],
  ['cannot resolve', 'cannotResolve'],
  ['cant resolve', 'cannotResolve'],
  ["can't resolve", 'cannotResolve'],
  ['cancelled', 'cancelled'],
  ['canceled', 'cancelled']
]);

function normalizeResolution (resolution) {
  if (typeof resolution !== 'string') {
    return resolution;
  }

  const normalized = RESOLUTION_ALIASES.get(resolution.trim().toLowerCase());
  return normalized || resolution;
}

function buildCanonicalError (response, body, retryable) {
  const status = response.status;
  let canonicalType = 'upstream_error';

  if (status === 400) {
    canonicalType = 'validation_error';
  } else if (status === 401) {
    canonicalType = 'auth_error';
  } else if (status === 403) {
    canonicalType = 'forbidden';
  } else if (status === 404) {
    canonicalType = 'not_found';
  } else if (status === 429) {
    canonicalType = 'rate_limit';
  }

  const apiMessageRaw = body && typeof body.message === 'string' ? body.message : response.statusText;
  const apiMessage = redactSensitiveQueryValues(apiMessageRaw);

  return new TicketingApiError(apiMessage, {
    statusCode: status,
    canonicalType,
    retryable
  });
}

function buildCanonicalNetworkError (error, retryable) {
  const message = error && error.message ? error.message : 'Network request failed';
  return new TicketingApiError(redactSensitiveQueryValues(message), {
    statusCode: 0,
    canonicalType: 'upstream_error',
    retryable,
    cause: error
  });
}

function normalizeIsResolved (value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }

  throw new Error('isResolved must be a boolean or a string value of true/false');
}

async function parseJsonSafe (response) {
  const raw = await response.text();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw };
  }
}

function normalizeSingleItemPayload (payload) {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  if (payload.item && typeof payload.item === 'object') {
    return payload.item;
  }

  if (payload.ticket && typeof payload.ticket === 'object') {
    return payload.ticket;
  }

  return payload;
}

function normalizeCollectionPayload (payload) {
  if (Array.isArray(payload)) {
    return {
      items: payload,
      itemCount: payload.length,
      continuationToken: undefined
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      items: [],
      itemCount: 0,
      continuationToken: undefined
    };
  }

  if (Array.isArray(payload.items)) {
    return {
      items: payload.items,
      itemCount: Number.isFinite(Number(payload.itemCount)) ? Number(payload.itemCount) : payload.items.length,
      continuationToken: payload.continuationToken
    };
  }

  if (payload.item && typeof payload.item === 'object') {
    return {
      items: [payload.item],
      itemCount: 1,
      continuationToken: payload.continuationToken
    };
  }

  return {
    items: [],
    itemCount: Number.isFinite(Number(payload.itemCount)) ? Number(payload.itemCount) : 0,
    continuationToken: payload.continuationToken
  };
}

export class TicketingApiAdapter {
  constructor(config) {
    if (!config || !config.apiKey) {
      throw new Error('apiKey is required');
    }

    this.apiKey = config.apiKey;
    this.defaultRegion = config.defaultRegion || 'us';
    this.defaultTimezone = config.defaultTimezone;
    this.maxRetries = Number.isInteger(config.maxRetries) ? config.maxRetries : 3;
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
    this.sleepImpl = config.sleepImpl || sleep;

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('fetch implementation is required');
    }

    if (typeof this.sleepImpl !== 'function') {
      throw new Error('sleep implementation is required');
    }
  }

  resolveHost (region) {
    const effectiveRegion = region || this.defaultRegion;
    const host = REGION_HOSTS[effectiveRegion];

    if (!host) {
      throw new Error(`Unsupported region: ${effectiveRegion}`);
    }

    return host;
  }

  async request ({ region, method, path, query = {}, headers = {}, body }) {
    const host = this.resolveHost(region);
    const url = new URL(`${host}${BASE_PATH}${path}`);

    const hasTimezone = query.timezone !== undefined && query.timezone !== null && query.timezone !== '';
    const timezone = hasTimezone ? query.timezone : this.defaultTimezone;
    // Explicit emptiness check: numeric 0 (UTC) is a valid offset but falsy, so it must not
    // be dropped or fall through to the server default.
    if (timezone !== undefined && timezone !== null && timezone !== '') {
      url.searchParams.set('timezone', String(timezone));
    }

    for (const [queryKey, value] of Object.entries(query)) {
      if (queryKey === 'timezone') {
        continue;
      }
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(queryKey, String(value));
      }
    }

    url.searchParams.set('key', this.apiKey);

    const requestInit = {
      method,
      headers: {
        Accept: 'application/json',
        ...headers
      }
    };

    if (body !== undefined) {
      requestInit.headers['Content-Type'] = 'application/json';
      requestInit.body = JSON.stringify(body);
    }

    let attempt = 0;
    while (attempt <= this.maxRetries) {
      const started = Date.now();

      try {
        const response = await this.fetchImpl(url, requestInit);
        const durationMs = Date.now() - started;
        const parsed = await parseJsonSafe(response);

        if (response.ok) {
          return {
            data: parsed,
            meta: {
              statusCode: response.status,
              durationMs,
              continuationToken: response.headers.get('continuationToken') || undefined,
              retryCount: attempt
            }
          };
        }

        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === this.maxRetries) {
          const error = buildCanonicalError(response, parsed, retryable);
          error.meta = {
            durationMs,
            retryCount: attempt
          };
          throw error;
        }
      } catch (error) {
        const durationMs = Date.now() - started;
        const isCanonicalError = error instanceof TicketingApiError;
        if (isCanonicalError) {
          throw error;
        }

        const retryable = true;
        if (attempt === this.maxRetries) {
          const canonicalError = buildCanonicalNetworkError(error, retryable);
          canonicalError.meta = {
            durationMs,
            retryCount: attempt
          };
          throw canonicalError;
        }
      }

      const backoffMs = Math.min(4000, 250 * Math.pow(2, attempt)) + Math.floor(Math.random() * 100);
      await this.sleepImpl(backoffMs);
      attempt += 1;
    }

    throw new Error('Unexpected adapter termination');
  }

  listTickets (input) {
    const query = {
      timezone: input.timezone,
      search: input.search,
      title: input.title,
      status: input.status,
      priority: input.priority,
      isResolved: normalizeIsResolved(input.isResolved),
      tags: input.tags,
      orderBy: input.orderBy,
      order: input.order,
      select: input.select,
      offset: input.offset,
      limit: input.limit,
      createdAfter: input.createdAfter,
      createdBefore: input.createdBefore,
      expectedDateAfter: input.expectedDateAfter,
      expectedDateBefore: input.expectedDateBefore,
      lastUpdateAfter: input.lastUpdateAfter,
      lastUpdateBefore: input.lastUpdateBefore
    };

    const headers = {};
    if (input.continuationToken) {
      headers.continuationToken = input.continuationToken;
    }

    return this.request({
      region: input.region,
      method: 'GET',
      path: '/tickets',
      query,
      headers
    }).then((response) => {
      const normalized = normalizeCollectionPayload(response.data);
      const token = response.meta.continuationToken || normalized.continuationToken;

      return {
        data: {
          items: normalized.items,
          itemCount: normalized.itemCount,
          continuationToken: token || null
        },
        meta: {
          ...response.meta,
          continuationToken: token || null
        }
      };
    });
  }

  getTicket (input) {
    return this.request({
      region: input.region,
      method: 'GET',
      path: `/tickets/${encodeURIComponent(input.ticketId)}`,
      query: {
        timezone: input.timezone
      }
    }).then((response) => ({
      data: {
        ticket: normalizeSingleItemPayload(response.data)
      },
      meta: response.meta
    }));
  }

  getTicketActivities (input) {
    const headers = {};
    if (input.continuationToken) {
      headers.continuationToken = input.continuationToken;
    }

    return this.request({
      region: input.region,
      method: 'GET',
      path: `/tickets/${encodeURIComponent(input.ticketId)}/activities`,
      query: {
        timezone: input.timezone,
        limit: input.limit
      },
      headers
    }).then((response) => {
      const normalized = normalizeCollectionPayload(response.data);
      const token = response.meta.continuationToken || normalized.continuationToken;

      return {
        data: {
          items: normalized.items,
          itemCount: normalized.itemCount,
          continuationToken: token || null
        },
        meta: {
          ...response.meta,
          continuationToken: token || null
        }
      };
    });
  }

  createTicket (input) {
    return this.request({
      region: input.region,
      method: 'POST',
      path: '/tickets',
      query: {
        timezone: input.timezone
      },
      body: {
        ticket: input.ticket,
        user: input.user
      }
    });
  }

  updateTicketStatus (input) {
    return this.request({
      region: input.region,
      method: 'PUT',
      path: `/tickets/${encodeURIComponent(input.ticketId)}/status`,
      query: {
        timezone: input.timezone
      },
      body: {
        status: input.status,
        resolution: normalizeResolution(input.resolution),
        comment: input.comment,
        user: input.user
      }
    });
  }

  updateTicket (input) {
    return this.request({
      region: input.region,
      method: 'PUT',
      path: `/tickets/${encodeURIComponent(input.ticketId)}`,
      query: {
        timezone: input.timezone
      },
      body: {
        ticket: input.ticket,
        user: input.user
      }
    });
  }

  addComment (input) {
    return this.request({
      region: input.region,
      method: 'POST',
      path: `/tickets/${encodeURIComponent(input.ticketId)}/activities`,
      query: {
        timezone: input.timezone
      },
      body: {
        comment: input.comment,
        user: input.user
      }
    });
  }

  getInstance (input) {
    return this.request({
      region: input.region,
      method: 'GET',
      path: '/instance',
      query: {
        timezone: input.timezone
      }
    });
  }

  getTags (input) {
    return this.request({
      region: input.region,
      method: 'GET',
      path: '/tags',
      query: {
        timezone: input.timezone
      }
    });
  }

  getTicketAttachments (input) {
    return this.request({
      region: input.region,
      method: 'GET',
      path: `/tickets/${encodeURIComponent(input.ticketId)}/attachments`,
      query: {
        timezone: input.timezone
      }
    });
  }

  // activityId must come from item.activityId in the addTicketAttachmentLinks response.
  // Passing an activityId from getTicketActivities returns a 500.
  getActivityAttachments (input) {
    return this.request({
      region: input.region,
      method: 'GET',
      path: `/tickets/activity/${encodeURIComponent(input.activityId)}/attachments`,
      query: {
        timezone: input.timezone
      }
    });
  }

  addTicketAttachmentLinks (input) {
    return this.request({
      region: input.region,
      method: 'POST',
      path: `/tickets/${encodeURIComponent(input.ticketId)}/attachments`,
      query: {
        timezone: input.timezone
      },
      body: {
        comment: input.comment,
        attachments: input.attachments,
        user: input.user,
        isPrivate: input.isPrivate ?? false
      }
    });
  }
}
