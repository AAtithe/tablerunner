import { userError } from './settings.js';

// Points a Postmark server's inbound webhook at Table Runner, using that
// server's API token, and returns the address OpenTable emails should be
// forwarded to. Postmark Server API: GET /server, PUT /server.
const API = 'https://api.postmarkapp.com';

export async function connectPostmark({ token, hookUrl, fetchImpl = fetch }) {
  const headers = { accept: 'application/json', 'content-type': 'application/json', 'x-postmark-server-token': token };

  const current = await fetchImpl(`${API}/server`, { headers });
  if (current.status === 401 || current.status === 422) {
    throw userError(400, "Postmark did not accept that token. In Postmark, open the server, choose API Tokens, and copy the Server API token.");
  }
  if (!current.ok) throw userError(502, `Postmark could not be reached (status ${current.status}). Try again in a minute.`);

  const updated = await fetchImpl(`${API}/server`, { method: 'PUT', headers, body: JSON.stringify({ InboundHookUrl: hookUrl }) });
  if (!updated.ok) throw userError(502, `Postmark refused the webhook change (status ${updated.status}).`);
  const server = await updated.json();
  if (server.InboundHookUrl !== hookUrl) throw userError(502, 'Postmark did not save the webhook address. Try again.');
  if (!server.InboundAddress) throw userError(502, 'Postmark returned no inbound address for this server.');
  return { serverName: server.Name, inboundAddress: server.InboundAddress };
}

// Postmark cannot sign in to Vercel, so the webhook must use an address that
// is publicly reachable. Checked by calling our own health endpoint there.
export async function assertPublic(origin, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`${origin}/api/health`, { redirect: 'manual' });
  } catch {
    throw userError(400, `Table Runner could not reach itself at ${origin}. Open it at its public address and try again.`);
  }
  if (res.status >= 300 && res.status < 400 || res.status === 401 || res.status === 403) {
    throw userError(400, `${origin} is behind Vercel's login, so Postmark could not deliver to it. Open Table Runner at its public address (for example https://tablerunner-eight.vercel.app) and connect again.`);
  }
}
