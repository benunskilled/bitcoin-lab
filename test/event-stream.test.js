'use strict';

// The page's side of /api/events. app.js is a browser script that touches the
// DOM at the top level, so startEventStream is lifted out of the real file and
// run against a stand-in EventSource and timer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS = path.join(__dirname, '..', 'src', 'dashboard', 'public', 'app.js');

function load() {
  const src = fs.readFileSync(APP_JS, 'utf8');
  const start = src.indexOf('const EVENT_STREAM_RETRY_MS');
  assert.ok(start > 0, 'app.js must still define EVENT_STREAM_RETRY_MS');
  const fnStart = src.indexOf('function startEventStream', start);
  assert.ok(fnStart > 0, 'app.js must still define startEventStream');
  const end = src.indexOf('\n}', fnStart) + 2;

  const sources = [];
  const timers = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = FakeEventSource.CONNECTING;
      this.listeners = {};
      sources.push(this);
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    fire(type, event = {}) {
      for (const fn of this.listeners[type] || []) fn(event);
    }
  }
  FakeEventSource.CONNECTING = 0;
  FakeEventSource.OPEN = 1;
  FakeEventSource.CLOSED = 2;

  const blocks = [];
  const context = {
    EventSource: FakeEventSource,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    applyBlockUpdate: (race) => blocks.push(race),
  };
  vm.runInNewContext(`${src.slice(start, end)}\nstartEventStream();`, context);
  return { sources, timers, blocks, FakeEventSource };
}

test('a refused stream (503, or the proxy while the app restarts) is tried again after 30s', () => {
  const { sources, timers, FakeEventSource } = load();
  assert.equal(sources.length, 1);
  sources[0].readyState = FakeEventSource.CLOSED;
  sources[0].fire('error');
  assert.equal(timers.length, 1, 'one retry is scheduled');
  assert.equal(timers[0].ms, 30000);
  timers[0].fn();
  assert.equal(sources.length, 2, 'the retry opens a new stream');
  assert.equal(sources[1].url, '/api/events');
});

test('a dropped stream that EventSource is already reconnecting is left to it', () => {
  // A second source next to the reconnecting one would mean two streams per
  // tab - and two slots of the 32.
  const { sources, timers, FakeEventSource } = load();
  sources[0].readyState = FakeEventSource.CONNECTING;
  sources[0].fire('error');
  assert.equal(timers.length, 0);
  assert.equal(sources.length, 1);
});

test('block events still reach the page', () => {
  const { sources, blocks } = load();
  sources[0].fire('block', { data: JSON.stringify({ id: 7, blockHeight: 912345 }) });
  assert.deepEqual(blocks.map((b) => b.id), [7]);
});
