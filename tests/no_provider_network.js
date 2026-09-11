import assert from 'node:assert/strict';
import { after } from 'node:test';

// Provider/auth requests must use injected responses. This also catches a test
// accidentally falling through to the default guest authentication provider.
let unexpectedRequests = 0;
globalThis.fetch = async () => {
  unexpectedRequests++;
  throw new Error('External provider requests are disabled in automated tests.');
};
after(() => {
  assert.equal(unexpectedRequests, 0, 'Tests attempted an unexpected external provider request');
});
