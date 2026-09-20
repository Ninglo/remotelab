#!/usr/bin/env node
import assert from 'assert/strict';

import {
  buildStablePersonHandle,
  derivePersonHandleBase,
  normalizePersonHandle,
  personHandleMatchesBase,
} from '../lib/person-handle.mjs';

assert.equal(derivePersonHandleBase('酒嘉年'), 'jiujianian');
assert.equal(derivePersonHandleBase('张予'), 'zhangyu');
assert.equal(derivePersonHandleBase('Jiu Jianian'), 'jiu-jianian');
assert.equal(normalizePersonHandle('  Jiǔ Jianian  '), 'jiu-jianian');

const first = buildStablePersonHandle({ displayName: '酒嘉年', seed: 'on_stable_user_1' });
const again = buildStablePersonHandle({ displayName: '酒嘉年', seed: 'on_stable_user_1' });
const second = buildStablePersonHandle({ displayName: '酒嘉年', seed: 'on_stable_user_2' });
assert.match(first, /^jiujianian-[a-f0-9]{4}$/);
assert.equal(first, again, 'the same Feishu person should keep one stable readable handle');
assert.notEqual(first, second, 'same-name people should receive different stable suffixes');
assert.equal(personHandleMatchesBase(first, 'jiujianian'), true);
assert.equal(personHandleMatchesBase('zhangyu95', 'zhangyu'), true);
assert.equal(personHandleMatchesBase('alexander', 'alex'), false);
assert.equal(personHandleMatchesBase('other-person-abcd', 'jiujianian'), false);

console.log('person handle tests passed');
