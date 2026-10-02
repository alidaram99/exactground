// Client for the hosted, paid ExactGround API (an Apify Standby Actor billed per event to the caller's Apify account).

export const API_URL = process.env.EXACTGROUND_API_URL || 'https://dropin-apis--exactground-api.apify.actor';

/** Call one MCP tool on the hosted API: check_symbols | check_packages | check_diff. */
export async function callApi(tool, args, { token = process.env.APIFY_TOKEN, fetchImpl = fetch, url = API_URL } = {}) {
  if (!token) throw new Error('Set APIFY_TOKEN (your Apify API token) to use the hosted API. The local checks need no token.');
  const res = await fetchImpl(`${url}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`API HTTP ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  if (body.error) throw new Error(body.error.message);
  const content = body.result?.structuredContent ?? body.result;
  return body.result?.isError ? { isError: true, ...content } : content;
}
