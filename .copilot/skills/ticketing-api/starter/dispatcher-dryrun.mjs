import { createToolDispatcher } from './dispatcher.js';

function assert (condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const dispatch = createToolDispatcher({
  apiKey: 'dry-run-placeholder',
  defaultRegion: 'us',
  defaultTimezone: '-5'
});

let confirmCalls = [];

const result = await dispatch(
  'update_ticket_status',
  {
    region: 'us',
    ticketId: '11111111-2222-3333-4444-555555555555',
    status: 'Closed',
    comment: 'dry run',
    user: {
      id: 'u1',
      name: 'Dry Runner',
      email: 'dry.runner@example.com'
    }
  },
  {
    confirmAction: async (payload) => {
      confirmCalls.push(payload);
      return false;
    }
  }
);

assert(result && result.cancelled === true, 'Expected cancelled=true for denied write operation.');
assert(confirmCalls.length === 1, 'Expected confirmAction to be called once.');
assert(confirmCalls[0].confirmationReason === 'high_impact_change', 'Expected high_impact_change for Closed status.');

const reassignResult = await dispatch(
  'update_ticket',
  {
    region: 'us',
    ticketId: '11111111-2222-3333-4444-555555555555',
    ticket: {
      assignee: {
        id: 'u2',
        name: 'Assignee',
        email: 'assignee@example.com'
      }
    },
    user: {
      id: 'u1',
      name: 'Dry Runner',
      email: 'dry.runner@example.com'
    }
  },
  {
    confirmAction: async (payload) => {
      confirmCalls.push(payload);
      return false;
    }
  }
);

assert(reassignResult && reassignResult.cancelled === true, 'Expected cancelled=true for denied reassignment.');
assert(confirmCalls[1].confirmationReason === 'high_impact_change', 'Expected high_impact_change for reassignment update_ticket.');

console.log('Dispatcher dry-run passed. Write operations were intercepted before any API mutation call.');
