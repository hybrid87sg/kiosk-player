# Stage 5: checklist for your real Home Assistants

The automatic tests (below) run every piece for real on one machine. These checks repeat the
ones that depend on real networks and real Home Assistants. **Do them only when you choose to**:
they need Kiosk server 0.7.0 on the main Home Assistant, which isn't released yet.

What you need: the main Home Assistant (Kiosk Signage add-on, main mode), the Qoltured and Linsy
Home Assistants (Kiosk add-on in relay mode, Kiosk Player integration from HACS), and one TV at each.

## Before you start

1. Back up the main Home Assistant (Settings → System → Backups). The upgrade keeps everything,
   but a backup costs nothing.
2. Update the main add-on to 0.7.0, then the relay add-ons to 0.7.0.
3. On the main server: Settings → Home Assistant Relays. Your relays are already listed, named after
   their add-ons' site names, marked "Waiting to pair". Their TVs keep working meanwhile.

## Pair each relay (cases 1 and 2)

For Qoltured, then Linsy:

- [ ] On the main server, press **Pairing code** on the relay. Keep the code on screen.
- [ ] On that site's Home Assistant: Kiosk add-on → Configuration → **Pairing code** → paste → Save → Restart.
      Its page (Open web UI) should say **Paired as Qoltured**.
- [ ] Settings → Devices & services → Add integration → **Kiosk Player**: the main server's Tailscale
      address and the same code. A device for the relay and one per TV appear.
- [ ] On the main server the relay shows both pieces **paired**, and **Home Assistant connected now**.

## Both at once, and ownership (cases 3 and 4)

- [ ] Both relays show **connected now** together.
- [ ] Qoltured's Home Assistant lists only Qoltured's TVs; Linsy's only Linsy's.

## Playlist control and an automation (cases 5 and 7)

- [ ] On Qoltured's Home Assistant, open a TV's device and change **Playlist choice**. The TV changes
      within a minute, and the main server's Screens page shows the new playlist.
- [ ] Make an automation there: trigger *Time 18:00* (or a button), action **Kiosk Player: Play playlist**,
      screens = the TV, playlist = `Automatic` (or a playlist's name). Run it and watch the TV change.

## Outages (cases 8, 9 and 10)

- [ ] **Main server outage:** stop the Kiosk add-on on the main Home Assistant for 5 minutes.
      Both relays show **Main server connected: off**; TVs keep playing what they have. Start it again:
      both reconnect by themselves within a minute; nothing asks to re-pair.
- [ ] **Tailscale drop at one site:** at Qoltured only, stop the Tailscale add-on for 5 minutes. Only
      Qoltured shows disconnected; Linsy carries on; Qoltured's TVs keep playing. Start Tailscale again: it
      reconnects by itself.
- [ ] **Relay restart:** restart Qoltured's Home Assistant (Settings → System → Restart). Everything comes
      back paired, with nothing to type.

## Revoking (case 11), only if you want to see it

- [ ] On the main server, **Revoke…** Qoltured's credentials. Its TVs keep playing (they are not removed);
      its Home Assistant shows **Reconfigure** for Kiosk Player.
- [ ] Recover: **New pairing code**, put it in the add-on's option (restart it) and in the Reconfigure form.
      The same TVs come back without being added again.

## Last step

- [ ] When every relay is paired, switch on **Only accept relays that have paired** (Settings → Home
      Assistant Relays). From then on nothing on your network can pretend to be a site.

---

## What the automatic tests cover

`homeassistant/integration/tests/test_end_to_end.py` starts the real main server, a real relay
add-on per site (its own process), Home Assistant with the integration, pretend TVs, and a link per
site that the test can cut (standing in for Tailscale). `server/test/boundaries.test.js` covers the rest.

| # | Case | Where | Result |
|---|------|-------|--------|
| 1 | Relay 001 pairing | test_end_to_end: `test_relays_pair_and_work_side_by_side` | automatic |
| 2 | Relay 002 pairing | same | automatic |
| 3 | Both relays connected at once | same | automatic |
| 4 | Player ownership | same | automatic |
| 5 | Playlist control | `test_playlist_control_and_automation` | automatic |
| 6 | Announcement control | not built (decision D4) | n/a |
| 7 | Home Assistant automation → Kiosk action | `test_playlist_control_and_automation` | automatic + checklist |
| 8 | Main server outage | `test_outages_link_drops_and_restarts` | automatic + checklist |
| 9 | Tailscale drop | same (one site's link cut) | automatic + checklist |
| 10 | Relay restart and reconnection | same | automatic + checklist |
| 11 | Credential revocation | `test_credential_revocation` | automatic |
| 12 | Relay 003 | `test_relays_pair_and_work_side_by_side` | automatic |
| 13 | Android username/password sign-in | server/test/boundaries.test.js | automatic |
| 14 | TV authentication | boundaries.test.js; also migration.test.js (0.6.0 tokens) | automatic |
| 15 | Dashboard and ingress boundaries | boundaries.test.js; relays.test.js | automatic |
