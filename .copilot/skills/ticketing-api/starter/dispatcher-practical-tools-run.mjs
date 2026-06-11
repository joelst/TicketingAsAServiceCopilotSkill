import { createToolDispatcher } from './dispatcher.js';

const apiKey = process.env.ticketingAPIKey || process.env.TICKETING_API_KEY;
const currentUserEmail = process.env.TICKETING_TEST_USER_EMAIL;
if (!apiKey) {
  throw new Error('Missing API key in ticketingAPIKey or TICKETING_API_KEY environment variable.');
}
if (!currentUserEmail) {
  throw new Error('Missing TICKETING_TEST_USER_EMAIL environment variable.');
}

const dispatch = createToolDispatcher({
  apiKey,
  defaultRegion: 'us',
  defaultTimezone: '-5',
  currentUserEmail
});

const unresolved = await dispatch('find_my_unresolved_tickets', {
  region: 'us',
  timezone: '-5',
  userEmail: currentUserEmail,
  top: 10,
  maxPages: 8,
  limit: 200
});

const unread = await dispatch('find_my_tickets_with_unread_updates', {
  region: 'us',
  timezone: '-5',
  userEmail: currentUserEmail,
  perspective: 'assignee',
  top: 10,
  maxPages: 8,
  limit: 200
});

const compact = {
  unresolved: {
    itemCount: unresolved.data.itemCount,
    totalMatchedBeforeTop: unresolved.data.totalMatchedBeforeTop,
    sample: unresolved.data.items.slice(0, 3).map((t) => ({
      ticketNo: t.ticketNo,
      status: t.status,
      title: t.title,
      priority: t.priority,
      requestorName: t.requestor && t.requestor.name,
      assigneeUnseenEventCnt: t.unseenUpdates && t.unseenUpdates.assignee,
      requestorUnseenEventCnt: t.unseenUpdates && t.unseenUpdates.requestor
    }))
  },
  unread: {
    itemCount: unread.data.itemCount,
    totalMatchedBeforeTop: unread.data.totalMatchedBeforeTop,
    sample: unread.data.items.slice(0, 3).map((t) => ({
      ticketNo: t.ticketNo,
      status: t.status,
      title: t.title,
      priority: t.priority,
      requestorName: t.requestor && t.requestor.name,
      assigneeUnseenEventCnt: t.unseenUpdates && t.unseenUpdates.assignee,
      requestorUnseenEventCnt: t.unseenUpdates && t.unseenUpdates.requestor
    }))
  }
};

console.log(JSON.stringify(compact, null, 2));
