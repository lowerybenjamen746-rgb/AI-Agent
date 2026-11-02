import assert from 'node:assert/strict';
import test from 'node:test';

import { ASPECT_SIZES, buildAspectCropFilter } from '../dist/aspect-crop.js';

test('every declared aspect has a size entry', () => {
  assert.deepEqual(Object.keys(ASPECT_SIZES).sort(), ['16:9', '1:1', '4:5', '9:16']);
  assert.deepEqual(ASPECT_SIZES['9:16'], [1080, 1920]);
});

test('the crop filter is a centred crop, then scale, then square pixels', () => {
  const filter = buildAspectCropFilter('9:16');
  assert.match(filter, /^crop=min\(iw\\,ih\*0\.5625\):min\(ih\\,iw\/0\.5625\):\(iw-min\(iw\\,ih\*0\.5625\)\)\/2:\(ih-min\(ih\\,iw\/0\.5625\)\)\/2,scale=1080:1920,setsar=1$/);
});

test('each aspect maps to its own ratio and output size', () => {
  const expected = { '9:16': 0.5625, '1:1': 1, '4:5': 0.8, '16:9': 1.7778 };
  for (const [aspect, ratio] of Object.entries(expected)) {
    const filter = buildAspectCropFilter(aspect);
    assert.ok(filter.includes(`${ratio.toFixed(4)}`), `${aspect} ratio`);
    const [w, h] = ASPECT_SIZES[aspect];
    assert.ok(filter.endsWith(`scale=${w}:${h},setsar=1`), `${aspect} scale`);
  }
});
