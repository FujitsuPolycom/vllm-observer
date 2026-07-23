async function request(path) {
  const response = await fetch(path, { cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

const instancePath = (name, resource) =>
  `/api/v1/instances/${encodeURIComponent(name)}/${resource}`;

export const api = {
  status: () => request('/api/v1/status'),
  instances: () => request('/api/v1/instances'),
  snapshot: name => request(instancePath(name, 'snapshot')),
  history: (name, limit = 3600) => request(`${instancePath(name, 'history')}?limit=${limit}`),
  logs: name => request(instancePath(name, 'logs')),
  config: name => request(instancePath(name, 'config')),
};
