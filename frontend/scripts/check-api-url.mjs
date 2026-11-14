#!/usr/bin/env node
/**
 * Tiny Layer-C check: simulationWsUrl / WS base join (mirrors frontend/src/lib/api.ts).
 * Run: node scripts/check-api-url.mjs
 * Exit 0 on success, 1 on failure.
 */

const WS_URL = "ws://localhost:8000";

function simulationWsUrl(wsPath, wsToken, wsBase = WS_URL) {
  if (
    !wsPath ||
    !wsPath.startsWith("/") ||
    wsPath.startsWith("//") ||
    /^wss?:\/\//i.test(wsPath)
  ) {
    throw new Error(
      "Invalid WebSocket path: only relative paths starting with / are allowed"
    );
  }
  let url = `${wsBase.replace(/\/$/, "")}${wsPath}`;
  if (wsToken) {
    url += `${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(wsToken)}`;
  }
  return url;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok  ${label}`);
}

function assertThrows(fn, label) {
  try {
    fn();
    console.error(`FAIL ${label}: expected throw`);
    process.exitCode = 1;
  } catch {
    console.log(`ok  ${label}`);
  }
}

assertEqual(
  simulationWsUrl("/api/simulate/ws/abc"),
  "ws://localhost:8000/api/simulate/ws/abc",
  "relative path"
);
assertEqual(
  simulationWsUrl("/api/simulate/ws/abc", "tok"),
  "ws://localhost:8000/api/simulate/ws/abc?token=tok",
  "token query"
);
assertEqual(
  simulationWsUrl("/api/simulate/ws/abc?x=1", "tok"),
  "ws://localhost:8000/api/simulate/ws/abc?x=1&token=tok",
  "token append with existing query"
);
assertThrows(
  () => simulationWsUrl("api/simulate/ws/abc"),
  "path without leading slash rejected"
);
assertThrows(
  () => simulationWsUrl("ws://127.0.0.1:8001/api/simulate/ws/x"),
  "absolute ws URL rejected"
);
assertEqual(
  simulationWsUrl("/api/simulate/ws/y", undefined, "ws://127.0.0.1:8001/"),
  "ws://127.0.0.1:8001/api/simulate/ws/y",
  "base trailing slash stripped"
);

if (!process.exitCode) {
  console.log("check-api-url: all passed");
}
