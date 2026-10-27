/**
 * Let the page breathe during long work: paint, take a click, run a timer.
 *
 * Not setTimeout(0). Chrome throttles timers in a tab that is not on screen —
 * to once a second, and after five minutes to once a minute — so a GIF of a
 * hundred thousand frames that yielded through setTimeout would take days if
 * you switched tabs while it saved. scheduler.yield() and a MessageChannel
 * round trip are not throttled.
 *
 * maybeYield() only actually yields every 16 ms or so, so a loop can call it
 * every iteration without paying for it every iteration.
 */

let last = 0;

export function yieldToPage() {
  if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
    channel.port2.postMessage(0);
  });
}

export function maybeYield() {
  const now = performance.now();
  if (now - last < 16) return null;
  last = now;
  return yieldToPage();
}
