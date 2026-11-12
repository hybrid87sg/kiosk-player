// Notifications through Home Assistant.
//
// As a Home Assistant add-on with "homeassistant_api" switched on, the server
// gets a token (SUPERVISOR_TOKEN) to ask Home Assistant to do things. Here it
// asks for notifications: Home Assistant's "notify" services, such as
// notify.mobile_app_<your phone> (the Home Assistant app on a phone) or
// notify.persistent_notification (the bell in Home Assistant's sidebar).

const LOCAL_PANEL = '/hassio/ingress/local_kiosk_server';

function createHomeAssistant({ baseUrl, token, supervisorUrl = null, fetchImpl = fetch }) {
  let panel = null;

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
    /**
     * Where Kiosk Signage lives in Home Assistant's sidebar, for the link in a
     * notification. The add-on's name there depends on how it was installed
     * ("local_kiosk_server" when copied in by hand, "<code>_kiosk_server" from
     * an add-on repository), so the Supervisor is asked once.
     */
    async panelPath() {
      if (panel) return panel;
      if (!supervisorUrl) return LOCAL_PANEL;
      try {
        const res = await fetchImpl(`${supervisorUrl}/addons/self/info`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        const slug = res.ok ? (await res.json())?.data?.slug : null;
        if (typeof slug === 'string' && /^[a-z0-9_]+$/.test(slug)) panel = `/hassio/ingress/${slug}`;
      } catch {
        // Asked again next time; the usual name is used meanwhile.
      }
      return panel || LOCAL_PANEL;
    },

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

module.exports = { createHomeAssistant, targetName, LOCAL_PANEL };
