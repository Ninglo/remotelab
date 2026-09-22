#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  mergeSessionPersonViews,
  projectSessionPersonView,
} from '../chat/session-person-view.mjs';

const session = {
  id: 'shared-session',
  personViews: {
    person_feishu: {
      space: 'Operations',
      group: 'Feishu inbox',
      sidebarOrder: 12,
    },
    person_web: {
      group: 'My current work',
    },
  },
};

assert.equal(mergeSessionPersonViews(session, 'person_feishu', 'person_web'), true);
assert.equal(Object.hasOwn(session.personViews, 'person_feishu'), false, 'the retired Person view should be removed');
assert.deepEqual(
  projectSessionPersonView(session, 'person_web'),
  {
    id: 'shared-session',
    space: 'Operations',
    group: 'My current work',
    sidebarOrder: 12,
  },
  'identity merging should retain source-only layout while preferring the target Person view on conflicts',
);
assert.equal(mergeSessionPersonViews(session, 'person_missing', 'person_web'), false);
assert.equal(mergeSessionPersonViews(session, 'person_web', 'person_web'), false);

console.log('test-session-person-view: ok');
