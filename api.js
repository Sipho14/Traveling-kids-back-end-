const BASE = '/api';

function authHeaders() {
  const token = localStorage.getItem('st_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (res.status === 401) {
    localStorage.removeItem('st_token');
    window.location.reload();
    return;
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Request failed');
  return res.json();
}

export const api = {
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  overview: () => request('/admin/overview'),
  students: () => request('/admin/students'),
  addStudent: (data) => request('/admin/students', { method: 'POST', body: data }),
  drivers: () => request('/admin/drivers'),
  addDriver: (data) => request('/admin/drivers', { method: 'POST', body: data }),
  vehicles: () => request('/admin/vehicles'),
  addVehicle: (data) => request('/admin/vehicles', { method: 'POST', body: data }),
  routes: () => request('/admin/routes'),
  addRoute: (data) => request('/admin/routes', { method: 'POST', body: data }),
  updateRoute: (id, data) => request(`/admin/routes/${id}`, { method: 'PATCH', body: data }),
  trips: (date) => request(`/admin/trips?date=${date}`),
  tripDetail: (id) => request(`/admin/trips/${id}`),
  updateTrip: (id, data) => request(`/admin/trips/${id}`, { method: 'PATCH', body: data }),
  sendDriverLink: (id) => request(`/admin/trips/${id}/send-driver-link`, { method: 'POST' }),
  suggestFix: (id) => request(`/admin/trips/${id}/suggest`, { method: 'POST' }),
  reorderStops: (tripId, stopIds) => request(`/admin/trips/${tripId}/stops/reorder`, { method: 'PATCH', body: { stop_ids: stopIds } }),
  reassignCandidates: (tripId) => request(`/admin/trips/${tripId}/reassign-candidates`),
  reassignStop: (stopId, tripId) => request(`/admin/stops/${stopId}/reassign`, { method: 'PATCH', body: { trip_id: tripId } }),
  alerts: () => request('/admin/alerts'),
  resolveAlert: (id) => request(`/admin/alerts/${id}/resolve`, { method: 'PATCH' }),
  escalatedConversations: () => request('/admin/conversations/escalated'),
  billingOverview: () => request('/admin/billing/overview'),
  payments: () => request('/admin/payments')
};
