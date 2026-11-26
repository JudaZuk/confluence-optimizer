import forge from './state.js';

export function route(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += v instanceof URLSearchParams ? v.toString() : encodeURIComponent(String(v));
    out += strings[i + 1];
  });
  return out;
}

const requester = (principal) => ({
  async requestConfluence(path, options = {}) {
    forge.confluenceLog.push({ principal, path, method: options.method || 'GET' });
    const { status, body, headers = {} } = await forge.confluence(path, options, principal);
    const text = body === undefined || body === null ? '' : JSON.stringify(body);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name) => headers[name] ?? null },
      text: async () => text,
    };
  },
});

export default { asApp: () => requester('app'), asUser: () => requester('user') };
