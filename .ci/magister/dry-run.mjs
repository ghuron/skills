/**
 * Preload for tests: `node --import ./dry-run.mjs magister.mjs ...`
 * Lets the login flow through, but refuses every other non-GET request so a test can
 * never submit anything to the school. The refused request is printed to stderr as
 * `DRY-RUN <json>` and answered with 204.
 */
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, init = {}) => {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method === 'GET' || new URL(url).hostname === 'accounts.magister.net') return realFetch(url, init);
  console.error(`DRY-RUN ${JSON.stringify({ method, url: String(url), body: init.body ? JSON.parse(init.body) : null })}`);
  return new Response(null, { status: 204 });
};
