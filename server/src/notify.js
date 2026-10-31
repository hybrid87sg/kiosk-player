// Notifications through Home Assistant.
//
// As a Home Assistant add-on with "homeassistant_api" switched on, the server
// gets a token (SUPERVISOR_TOKEN) to ask Home Assistant to do things. Here it
// asks for notifications: Home Assistant's "notify" services, such as
// notify.mobile_app_<your phone> (the Home Assistant app on a phone) or
// notify.persistent_notification (the bell in Home Assistant's sidebar).

function createHomeAssistant({ baseUrl, token, fetchImpl = fetch }) {
  async function call(method, path, body) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
    return res.json().catch(() => null);
  }

  return {
    /** The notify services Home Assistant offers, e.g. [{ id: 'mobile_app_pixel_8', name: 'Phone: pixel 8' }]. */
    async listTargets() {
      const domains = await call('GET', '/services');
      const notify = (domains || []).find((d) => d.domain === 'notify');
      return Object.keys((notify && notify.services) || {})
        .filter((id) => id !== 'send_message') // needs an entity, not a simple target
        .sort()
        .map((id) => ({ id, name: targetName(id) }));
    },

    /** Sends one notification through notify.<target>. */
    async send(target, { title, message, data }) {
      if (!/^[a-z0-9_]+$/.test(target)) throw new Error(`Not a notify service: ${target}`);
      await call('POST', `/services/notify/${target}`, { title, message, data });
    },
  };
}

/** A readable name for a notify service. */
function targetName(id) {
  if (id === 'persistent_notification') return 'Home Assistant notifications (the bell in the sidebar)';
  if (id === 'notify') return 'Default notify service';
  if (id.startsWith('mobile_app_')) return `Phone or tablet: ${id.slice('mobile_app_'.length).replace(/_/g, ' ')}`;
  return id.replace(/_/g, ' ');
}

module.exports = { createHomeAssistant, targetName };
