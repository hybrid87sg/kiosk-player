"""Stage 5: the handover's test cases, with every piece running for real (see system.py).

Numbers in the comments are the handover's (§9, Stage 5):
 1 Relay 001 pairing             6 Announcement control (not built: decision D4)  11 Credential revocation
 2 Relay 002 pairing             7 Home Assistant automation → Kiosk action       12 Relay 003
 3 Both relays at once           8 Main server outage                             13–15: server/test/boundaries.test.js
 4 Player ownership              9 Tailscale drop (one site's link cut)
 5 Playlist control             10 Relay restart and reconnection
"""

from __future__ import annotations

from dataclasses import dataclass, field

from homeassistant import config_entries
from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.setup import async_setup_component
import pytest

from custom_components.kiosk_player.api import KioskNotFound
from custom_components.kiosk_player.const import DOMAIN

from .conftest import KioskServer
from .system import CutLink, RelayAddon, Tv
from .test_integration import state, wait_for


@dataclass
class Site:
    """One site: its relay on the main server, its link, its add-on, its Home Assistant entry, its TVs."""

    name: str
    relay_id: str
    link: CutLink
    addon: RelayAddon
    entry: ConfigEntry | None = None
    tvs: list[Tv] = field(default_factory=list)


async def add_site(hass: HomeAssistant, server: KioskServer, name: str, tmp_path, sites: list[Site]) -> Site:
    """What an admin does for a new site: make the relay, put the code in the add-on and the integration."""
    made = await server.make_relay(name)
    code = made["pairing_code"]
    link = CutLink(int(server.url.rsplit(":", 1)[1]))
    await link.start()
    addon = RelayAddon(name, link.url, str(tmp_path / f"relay-{name}"))
    site = Site(name, made["relay"]["id"], link, addon)
    sites.append(site)
    await addon.start(code)
    await wait_for(hass, lambda: True)
    for _ in range(100):
        if (await addon.pairing())["state"] == "paired":
            break
        await wait_for(hass, lambda: True, 0.2)
    assert (await addon.pairing()) | {"message": None} == {
        "state": "paired",
        "message": None,
        "relay_name": name,
        "code_given": True,
    }
    # The same code, typed into the integration on that site's Home Assistant.
    flow = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(flow["flow_id"], {"url": link.url, "pairing_code": code})
    assert result["type"] is FlowResultType.CREATE_ENTRY, result
    site.entry = hass.config_entries.async_get_entry(result["result"].entry_id)
    await wait_for(hass, lambda: site.entry.runtime_data.socket.connected)
    return site


async def add_tv(server: KioskServer, site: Site, name: str) -> Tv:
    """A TV at the site finds the relay, shows a code, and an admin adds it on the main server."""
    tv = Tv(site.addon.url)
    await tv.register()
    status, claimed = await server.call(
        "POST", "/api/devices/claim", {"code": tv.pairing_code, "name": name, "location": site.name}
    )
    assert status == 200, claimed
    tv.id = claimed["id"]
    assert claimed["relay"]["id"] == site.relay_id  # proven by the add-on's credential, not a header
    site.tvs.append(tv)
    return tv


@pytest.fixture
async def sites(hass: HomeAssistant, kiosk_server: KioskServer):
    made: list[Site] = []
    yield made
    for site in made:
        if site.entry is not None and site.entry.state is ConfigEntryState.LOADED:
            await hass.config_entries.async_unload(site.entry.entry_id)
        await site.addon.stop()
        await site.link.close()
    await hass.async_block_till_done()


def entity(hass: HomeAssistant, site: Site, unique_suffix: str) -> str:
    for e in er.async_entries_for_config_entry(er.async_get(hass), site.entry.entry_id):
        if e.unique_id == f"{site.entry.unique_id}_{unique_suffix}":
            return e.entity_id
    raise AssertionError(f"no entity {unique_suffix}")


async def test_relays_pair_and_work_side_by_side(hass, kiosk_server: KioskServer, sites, tmp_path) -> None:
    # 1, 2: each relay pairs both pieces with one code.
    qoltured = await add_site(hass, kiosk_server, "Qoltured", tmp_path, sites)
    linsy = await add_site(hass, kiosk_server, "Linsy", tmp_path, sites)
    cafe = await add_tv(kiosk_server, qoltured, "Cafe wall")
    counter = await add_tv(kiosk_server, linsy, "Counter")

    # 3: both connected at once, each with its own screen only.
    _, listing = await kiosk_server.call("GET", "/api/relays")
    view = {r["name"]: r for r in listing["relays"]}
    for name in ("Qoltured", "Linsy"):
        assert view[name]["paired"] == {"control": True, "proxy": True}
        assert view[name]["connected"] is True
        assert view[name]["status"] == "active"
    await wait_for(hass, lambda: cafe.id in qoltured.entry.runtime_data.data)
    await wait_for(hass, lambda: counter.id in linsy.entry.runtime_data.data)
    assert set(qoltured.entry.runtime_data.data) == {cafe.id}
    assert set(linsy.entry.runtime_data.data) == {counter.id}
    assert state(hass, entity(hass, qoltured, "server_connected")) == "on"
    assert state(hass, entity(hass, linsy, "server_connected")) == "on"

    # 4: Qoltured's Home Assistant can't control or even see Linsy's screen.
    with pytest.raises(KioskNotFound):
        await qoltured.entry.runtime_data.api.command(counter.id, "refresh")
    status, _ = await kiosk_server.call(
        "GET", f"/api/relay/v1/players/{counter.id}", token=qoltured.entry.data["credential"]
    )
    assert status == 404
    # A Linsy TV turning up at Qoltured's relay stays Linsy's.
    moved = Tv(qoltured.addon.url)
    moved.token = counter.token
    assert (await moved.heartbeat())[0] == 200
    await qoltured.entry.runtime_data.async_refresh()
    assert set(qoltured.entry.runtime_data.data) == {cafe.id}

    # 12: a third site needs no code change: same steps, and all three run together.
    third = await add_site(hass, kiosk_server, "Relay 003", tmp_path, sites)
    kiosk3 = await add_tv(kiosk_server, third, "Kiosk 3")
    await wait_for(hass, lambda: kiosk3.id in third.entry.runtime_data.data)
    _, listing = await kiosk_server.call("GET", "/api/relays")
    assert sorted(r["name"] for r in listing["relays"] if r["connected"]) == ["Linsy", "Qoltured", "Relay 003"]
    assert len(hass.config_entries.async_entries(DOMAIN)) == 3


async def prepare_content(server: KioskServer) -> tuple[int, dict]:
    """The picture from Drive, in a 'Promo' playlist at Qoltured. Returns (media id, playlist)."""
    status, _ = await server.call("POST", "/api/media/sync")
    assert status == 200
    _, media = await server.call("GET", "/api/media")
    media_id = media["items"][0]["id"]
    promo = await server.add_playlist("Promo", "Qoltured")
    status, _ = await server.call("PUT", f"/api/playlists/{promo['id']}/items", {"items": [{"media_id": media_id}]})
    assert status == 200
    return media_id, promo


async def test_playlist_control_and_automation(hass, kiosk_server: KioskServer, sites, tmp_path) -> None:
    qoltured = await add_site(hass, kiosk_server, "Qoltured", tmp_path, sites)
    cafe = await add_tv(kiosk_server, qoltured, "Cafe wall")
    media_id, promo = await prepare_content(kiosk_server)
    coordinator = qoltured.entry.runtime_data
    commands: list = []
    hass.bus.async_listen(f"{DOMAIN}_command_updated", lambda e: commands.append(e.data))
    await wait_for(hass, lambda: cafe.id in coordinator.data)
    select = entity(hass, qoltured, f"{cafe.id}_playlist_select")
    await wait_for(hass, lambda: "Promo" in hass.states.get(select).attributes["options"])

    # 5: choosing "Promo" in Home Assistant → the TV sees a new version at its next check-in, fetches the
    #    playlist through its relay, downloads the file through the relay, and the command is acknowledged.
    _, before = await cafe.heartbeat()
    await hass.services.async_call("select", "select_option", {"entity_id": select, "option": "Promo"}, blocking=True)
    _, after = await cafe.heartbeat()
    assert after["version"] != before["version"]
    status, playlist = await cafe.playlist()
    assert status == 200
    assert [i["id"] for i in playlist["items"]] == [media_id]
    status, data = await cafe.download(media_id)
    assert status == 200 and len(data) == 200 * 1024
    await wait_for(hass, lambda: any(c["status"] == "acknowledged" for c in commands))
    await wait_for(hass, lambda: state(hass, select) == "Promo")

    # 7: a normal Home Assistant automation drives it: at "closing" (an event here), back to Automatic.
    device = dr.async_get(hass).async_get_device({(DOMAIN, f"{qoltured.entry.unique_id}_{cafe.id}")})
    assert await async_setup_component(
        hass,
        "automation",
        {
            "automation": {
                "alias": "Qoltured evening",
                "triggers": [{"trigger": "event", "event_type": "kiosk_test_closing_time"}],
                "actions": [
                    {
                        "action": "kiosk_player.play_playlist",
                        "data": {"device_id": device.id, "playlist": "Automatic"},
                    }
                ],
            }
        },
    )
    hass.bus.async_fire("kiosk_test_closing_time")
    await wait_for(hass, lambda: state(hass, select) == "Automatic")
    _, player = await kiosk_server.call(
        "GET", f"/api/relay/v1/players/{cafe.id}", token=qoltured.entry.data["credential"]
    )
    assert player["playlist_auto"] is True


async def test_outages_link_drops_and_restarts(hass, kiosk_server: KioskServer, sites, tmp_path) -> None:
    qoltured = await add_site(hass, kiosk_server, "Qoltured", tmp_path, sites)
    linsy = await add_site(hass, kiosk_server, "Linsy", tmp_path, sites)
    cafe = await add_tv(kiosk_server, qoltured, "Cafe wall")
    counter = await add_tv(kiosk_server, linsy, "Counter")
    media_id, promo = await prepare_content(kiosk_server)
    # The relay keeps its own copy of a file once a TV has downloaded it.
    await qoltured.entry.runtime_data.api.command(cafe.id, "play_playlist", {"playlist_id": promo["id"]})
    assert (await cafe.playlist())[0] == 200
    assert (await cafe.download(media_id))[0] == 200
    q_connected = entity(hass, qoltured, "server_connected")
    l_connected = entity(hass, linsy, "server_connected")
    reauth = lambda: [f for f in hass.config_entries.flow.async_progress() if f["context"]["source"] == "reauth"]  # noqa: E731

    # 9: Qoltured's link to the main server drops. Only Qoltured notices; Linsy carries on.
    await qoltured.link.cut()
    await wait_for(hass, lambda: state(hass, q_connected) == "off")
    assert state(hass, l_connected) == "on"
    assert (await counter.heartbeat())[0] == 200
    # Qoltured's TV: its check-in fails as "can't reach" (never "removed"), and its file still comes from the relay.
    status, _ = await cafe.heartbeat()
    assert status == 502
    assert (await cafe.download(media_id))[0] == 200
    await qoltured.link.restore()
    await wait_for(hass, lambda: state(hass, q_connected) == "on", 30)
    assert (await cafe.heartbeat())[0] == 200
    assert not reauth()

    # 8: the main server itself is down for a while.
    await kiosk_server.stop()
    await wait_for(hass, lambda: state(hass, q_connected) == "off" and state(hass, l_connected) == "off")
    assert (await cafe.heartbeat())[0] == 502
    assert (await counter.heartbeat())[0] == 502
    assert (await cafe.download(media_id))[0] == 200  # still playing from the relay's copy
    await kiosk_server.start()
    await wait_for(hass, lambda: state(hass, q_connected) == "on" and state(hass, l_connected) == "on", 40)
    assert (await cafe.heartbeat())[0] == 200
    assert (await counter.heartbeat())[0] == 200
    assert not reauth()
    assert qoltured.entry.state is ConfigEntryState.LOADED and linsy.entry.state is ConfigEntryState.LOADED

    # 10: Qoltured's Home Assistant restarts: the add-on (same /data, the used code still in its options)
    #     and the integration come back without pairing again.
    await qoltured.addon.stop()
    assert await hass.config_entries.async_unload(qoltured.entry.entry_id)
    await qoltured.addon.start(pairing_code="(the used code stays in the options)")
    assert (await qoltured.addon.pairing())["state"] == "paired"
    assert await hass.config_entries.async_setup(qoltured.entry.entry_id)
    await wait_for(hass, lambda: qoltured.entry.runtime_data.socket.connected)
    assert (await cafe.heartbeat())[0] == 200
    assert (await cafe.download(media_id))[0] == 200
    assert not reauth()


async def test_credential_revocation(hass, kiosk_server: KioskServer, sites, tmp_path) -> None:
    qoltured = await add_site(hass, kiosk_server, "Qoltured", tmp_path, sites)
    linsy = await add_site(hass, kiosk_server, "Linsy", tmp_path, sites)
    cafe = await add_tv(kiosk_server, qoltured, "Cafe wall")
    counter = await add_tv(kiosk_server, linsy, "Counter")
    _, view = await kiosk_server.call("GET", f"/api/relays/{qoltured.relay_id}")
    creds = {c["kind"]: c["id"] for c in view["credentials"]}

    # 11: an admin revokes both of Qoltured's credentials (e.g. its Home Assistant was stolen).
    for kind in ("proxy", "control"):
        status, _ = await kiosk_server.call("POST", f"/api/relays/{qoltured.relay_id}/credentials/{creds[kind]}/revoke")
        assert status == 200
    # Its TVs are refused with "try again later", never "removed": they keep their pairing and files.
    status, body = await cafe.heartbeat()
    assert status == 503, body
    # Its Home Assistant is disconnected and asks for a new code. Linsy is untouched.
    flows = hass.config_entries.flow.async_progress
    await wait_for(hass, lambda: any(f["context"]["source"] == "reauth" for f in flows()))
    assert (await counter.heartbeat())[0] == 200
    assert linsy.entry.runtime_data.socket.connected

    # Recovery: one new code, into both pieces.
    code = await kiosk_server.new_code(qoltured.relay_id)
    await qoltured.addon.stop()
    await qoltured.addon.start(code)
    for _ in range(100):
        if (await qoltured.addon.pairing())["state"] == "paired":
            break
        await wait_for(hass, lambda: True, 0.2)
    flow = next(f for f in hass.config_entries.flow.async_progress() if f["context"]["source"] == "reauth")
    result = await hass.config_entries.flow.async_configure(flow["flow_id"], {"pairing_code": code})
    assert result["reason"] == "reauth_successful"
    await wait_for(hass, lambda: qoltured.entry.state is ConfigEntryState.LOADED)
    await wait_for(hass, lambda: qoltured.entry.runtime_data.socket.connected)
    status, _ = await cafe.heartbeat()
    assert status == 200  # the same TV, same token: it never had to be added again
