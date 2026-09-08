import assert from "node:assert/strict";
import test, { after } from "node:test";

import { RequestHandler } from "./request-handler.js";
import { ScreenshotCache } from "./cache.js";

// Keep debug noise out of the test output; console.log stays untouched so the
// test reporter keeps working.
console.debug = () => {};

// In-memory HTTP response recording what the handler writes
class FakeResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.body = Buffer.alloc(0);
    this.finished = false;
  }
  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }
  write(chunk) {
    this.body = Buffer.concat([this.body, Buffer.from(chunk)]);
    return true;
  }
  end() {
    this.finished = true;
  }
}

// A fake browser: every screenshotPage call counts as a render and returns a
// unique image so cache hits are distinguishable from fresh renders.
function makeBrowser() {
  return {
    navigations: 0,
    renders: 0,
    async navigatePage() {
      this.navigations++;
      return { time: 10 };
    },
    async screenshotPage(requestParams) {
      this.renders++;
      return {
        image: Buffer.from(`img:${this.renders}:${requestParams.pagePath}`),
        time: 50,
      };
    },
    async cleanup() {},
  };
}

const handlers = [];

function setup() {
  const browser = makeBrowser();
  const handler = new RequestHandler(browser);
  handlers.push(handler);
  return { browser, handler };
}

// Send one request and wait for the handler to finish; returns the response.
async function serve(handler, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const response = new FakeResponse();
  await handler.handleRequest(
    { url: `${path}${qs ? `?${qs}` : ""}` },
    response,
  );
  return response;
}

// Send a request without awaiting completion (for in-flight render tests).
function begin(handler, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const response = new FakeResponse();
  const promise = handler.handleRequest(
    { url: `${path}${qs ? `?${qs}` : ""}` },
    response,
  );
  return { response, promise };
}

// Age every cache entry so freshness windows can be tested without waiting
function ageCache(handler, seconds) {
  for (const key of [...handler.cache.map.keys()]) {
    handler.cache._ageEntry(key, seconds * 1000);
  }
}

after(() => {
  for (const handler of handlers) {
    clearTimeout(handler.browserCleanupTimer);
  }
});

test("first fromcacheifyounger request renders and stores the screenshot", async () => {
  const { browser, handler } = setup();
  const response = await serve(handler, "/home", {
    viewport: "100x100",
    fromcacheifyounger: "60",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Content-Type"], "image/png");
  assert.equal(browser.renders, 1);
  assert.equal(browser.navigations, 1);
  assert.equal(handler.cache.currentBytes, response.body.length);
});

test("second request within age serves the identical screenshot without rendering", async () => {
  const { browser, handler } = setup();
  const first = await serve(handler, "/home", {
    viewport: "100x100",
    fromcacheifyounger: "60",
  });

  const second = await serve(handler, "/home", {
    viewport: "100x100",
    fromcacheifyounger: "60",
  });

  assert.equal(second.statusCode, 200);
  assert.equal(second.headers["Content-Type"], "image/png");
  // Identical image served from cache; browser untouched
  assert.ok(second.body.equals(first.body));
  assert.equal(browser.renders, 1);
  assert.equal(browser.navigations, 1);
});

test("fromcacheifyounger=60 re-renders when the cached copy is older than 60s", async () => {
  const { browser, handler } = setup();
  await serve(handler, "/home", {
    viewport: "100x100",
    fromcacheifyounger: "60",
  });

  ageCache(handler, 61);

  await serve(handler, "/home", {
    viewport: "100x100",
    fromcacheifyounger: "60",
  });

  assert.equal(browser.renders, 2);
});

test("fromcacheifyounger=always serves any prior screenshot regardless of age", async () => {
  const { browser, handler } = setup();
  const first = await serve(handler, "/home", {
    viewport: "100x100",
    fromcacheifyounger: "always",
  });

  ageCache(handler, 100_000);

  const second = await serve(handler, "/home", {
    viewport: "100x100",
    fromcacheifyounger: "always",
  });

  assert.equal(second.statusCode, 200);
  assert.ok(second.body.equals(first.body));
  assert.equal(browser.renders, 1);
});

test("different parameters get separate cache entries", async () => {
  const { browser, handler } = setup();
  const base = { viewport: "100x100", fromcacheifyounger: "60" };

  await serve(handler, "/home", base);
  await serve(handler, "/home", base);
  assert.equal(browser.renders, 1, "identical params hit the cache");

  await serve(handler, "/home", { ...base, viewport: "200x200" });
  assert.equal(browser.renders, 2, "different viewport re-renders");

  await serve(handler, "/other", base);
  assert.equal(browser.renders, 3, "different path re-renders");

  await serve(handler, "/home", { ...base, theme: "midnight" });
  assert.equal(browser.renders, 4, "different theme re-renders");
});

test("format difference keys the cache separately and serves correct content type", async () => {
  const { browser, handler } = setup();
  const jpeg = await serve(handler, "/home", {
    viewport: "100x100",
    fromcacheifyounger: "60",
    format: "jpeg",
  });
  assert.equal(jpeg.headers["Content-Type"], "image/jpeg");

  const jpeg2 = await serve(handler, "/home", {
    viewport: "100x100",
    fromcacheifyounger: "60",
    format: "jpeg",
  });
  assert.ok(jpeg2.body.equals(jpeg.body));
  assert.equal(browser.renders, 1, "same format hit the cache");

  await serve(handler, "/home", {
    viewport: "100x100",
    fromcacheifyounger: "60",
  });
  assert.equal(browser.renders, 2, "png is a different cache key");
});

test("requests without fromcacheifyounger never touch the cache", async () => {
  const { browser, handler } = setup();
  await serve(handler, "/home", { viewport: "100x100" });
  await serve(handler, "/home", { viewport: "100x100" });

  assert.equal(browser.renders, 2);
  assert.equal(handler.cache.currentBytes, 0);
});

test("invalid fromcacheifyounger values are rejected with 400", async () => {
  const { handler } = setup();
  for (const bad of ["abc", "-5", "", "1e", "NaN"]) {
    const response = await serve(handler, "/home", {
      viewport: "100x100",
      fromcacheifyounger: bad,
    });
    assert.equal(
      response.statusCode,
      400,
      `expected 400 for ${JSON.stringify(bad)}`,
    );
  }
});

test("fractional and zero seconds are accepted", async () => {
  const { browser, handler } = setup();
  await serve(handler, "/home", {
    viewport: "100x100",
    fromcacheifyounger: "0.5",
  });
  // Past the 0.5s window -> fresh render
  ageCache(handler, 1);
  await serve(handler, "/home", {
    viewport: "100x100",
    fromcacheifyounger: "0.5",
  });
  assert.equal(browser.renders, 2);

  // fromcacheifyounger=0 only serves screenshots from the same millisecond;
  // an entry aged by 1ms is too old.
  const zero = setup();
  await serve(zero.handler, "/home", {
    viewport: "100x100",
    fromcacheifyounger: "0",
  });
  ageCache(zero.handler, 0.001);
  await serve(zero.handler, "/home", {
    viewport: "100x100",
    fromcacheifyounger: "0",
  });
  assert.equal(zero.browser.renders, 2);
});

test("next pre-warm with fromcacheifyounger refreshes the cache with a fresh render", async () => {
  const { browser, handler } = setup();
  const params = {
    viewport: "100x100",
    fromcacheifyounger: "always",
    // nextWaitTime = next*1000 - requestTime - navigationTime - 1000; the
    // fake browser takes ~0ms, so next=2s fires ~1s later.
    next: "2",
  };

  // Poll #1: renders, stores in cache, schedules the pre-warm timer
  const first = await serve(handler, "/home", params);
  assert.equal(browser.renders, 1);
  assert.equal(browser.navigations, 1);

  // Wait for the scheduled pre-warm to fire and finish (~1s + margin)
  const deadline = Date.now() + 4000;
  while (browser.renders < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // Pre-warm rendered a fresh image into the cache
  assert.equal(browser.renders, 2, "pre-warm must render and refresh cache");
  assert.equal(browser.navigations, 2);
  assert.equal(handler.cache.currentBytes > 0, true);

  // Poll #2: instant serve of the refreshed image (different bytes)
  const second = await serve(handler, "/home", params);
  assert.equal(second.statusCode, 200);
  assert.equal(browser.renders, 2, "second poll must not render again");
  assert.notDeepEqual(
    second.body,
    first.body,
    "served image must be the refreshed one",
  );
});

test("next pre-warm without fromcacheifyounger only navigates (no cache memory)", async () => {
  const { browser, handler } = setup();
  await serve(handler, "/home", { viewport: "100x100", next: "2" });
  assert.equal(browser.renders, 1);

  // Wait for the scheduled pre-warm to fire (~1s + margin)
  const deadline = Date.now() + 4000;
  while (browser.navigations < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(browser.navigations, 2, "pre-warm navigates");
  assert.equal(browser.renders, 1, "no screenshot render without a cache key");
  assert.equal(handler.cache.currentBytes, 0);
});

test("cached serve re-arms the next pre-warm so the refresh chain continues", async () => {
  const { browser, handler } = setup();
  const params = {
    viewport: "100x100",
    fromcacheifyounger: "always",
    next: "2",
  };

  // Poll 1 renders and schedules pre-warm #1
  await serve(handler, "/home", params);
  const deadline1 = Date.now() + 4000;
  while (browser.renders < 2 && Date.now() < deadline1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(browser.renders, 2, "pre-warm #1 refreshed the cache");

  // Poll 2 is a cached serve — it must schedule pre-warm #2
  await serve(handler, "/home", params);
  const deadline2 = Date.now() + 4000;
  while (browser.renders < 3 && Date.now() < deadline2) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(browser.renders, 3, "cached serve re-armed the pre-warm");

  // And the refreshed image is in the cache for the next poll
  const third = await serve(handler, "/home", params);
  assert.equal(third.statusCode, 200);
  assert.equal(browser.renders, 3);
});

test("cache hit waits for an identical in-flight render instead of re-rendering", async () => {
  let releaseFirst;
  const gate = new Promise((resolve) => (releaseFirst = resolve));
  const slowBrowser = {
    navigations: 0,
    renders: 0,
    async navigatePage() {
      this.navigations++;
      return { time: 10 };
    },
    async screenshotPage() {
      await gate;
      this.renders++;
      return { image: Buffer.from("slow"), time: 50 };
    },
    async cleanup() {},
  };
  const handler = new RequestHandler(slowBrowser);
  handlers.push(handler);

  const first = begin(handler, "/home", {
    viewport: "100x100",
    fromcacheifyounger: "60",
  });

  // Give the first request time to take the busy lock and start rendering
  await new Promise((resolve) => setTimeout(resolve, 20));

  const second = begin(handler, "/home", {
    viewport: "100x100",
    fromcacheifyounger: "60",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    second.response.finished,
    false,
    "must wait for the in-flight render",
  );

  releaseFirst();
  await Promise.all([first.promise, second.promise]);

  // The second request was served the screenshot rendered by the first
  assert.equal(slowBrowser.renders, 1);
  assert.ok(second.response.finished);
  assert.ok(second.response.body.equals(first.response.body));
});

test("bad viewport still returns 400 when fromcacheifyounger is set", async () => {
  const { browser, handler } = setup();
  const response = await serve(handler, "/home", {
    fromcacheifyounger: "60",
  });
  assert.equal(response.statusCode, 400);
  assert.equal(browser.renders, 0);
});

test("ScreenshotCache evicts least-recently-used entries by total bytes", () => {
  const cache = new ScreenshotCache(100);
  cache.put("a", Buffer.alloc(40));
  cache.put("b", Buffer.alloc(40));
  assert.equal(cache.currentBytes, 80);

  // Touch "a" so "b" becomes the LRU entry
  cache.get("a");

  cache.put("c", Buffer.alloc(40)); // evicts b, keeps a
  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.has("c"), true);
  assert.equal(cache.currentBytes, 80);

  // Oversized single entry is not cached and leaves the cache untouched
  cache.put("big", Buffer.alloc(500));
  assert.equal(cache.has("big"), false);
  assert.equal(cache.currentBytes, 80);

  // Replacing an existing key does not double-count bytes
  cache.put("a", Buffer.alloc(40));
  assert.equal(cache.currentBytes, 80);
  assert.equal(cache.has("c"), true);
});
