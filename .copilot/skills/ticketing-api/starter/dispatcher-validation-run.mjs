import { createToolDispatcher } from './dispatcher.js';

const apiKey = process.env.ticketingAPIKey || process.env.TICKETING_API_KEY;
const assigneeEmail = process.env.TICKETING_TEST_USER_EMAIL;
const requestorEmail = process.env.TICKETING_TEST_REQUESTOR_EMAIL;
if (!apiKey) {
  throw new Error('Missing API key in ticketingAPIKey or TICKETING_API_KEY environment variable.');
}
if (!assigneeEmail) {
  throw new Error('Missing TICKETING_TEST_USER_EMAIL environment variable.');
}
if (!requestorEmail) {
  throw new Error('Missing TICKETING_TEST_REQUESTOR_EMAIL environment variable. This write-capable validation requires an explicit requestor to avoid mutating unintended tickets.');
}

const dispatch = createToolDispatcher({
  apiKey,
  defaultRegion: 'us',
  defaultTimezone: '-5'
});

const result = await dispatch(
  'validation_write_closed_ticket_comment',
  {
    region: 'us',
    timezone: '-5',
    assigneeEmail,
    requestorEmail,
    allowResolvedFallback: true
  },
  {
    confirmAction: async () => true
  }
);

console.log(JSON.stringify(result, null, 2));
