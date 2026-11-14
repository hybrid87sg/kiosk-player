# Home Assistant examples for Kiosk Player

These work on a **relay** site's Home Assistant with the **Kiosk Player** integration
(see *Adding another site* in the [README](../README.md)). Each screen is a Home Assistant
device, named as on the main server. The examples use a screen called **Cafe wall** at a site
called **Qoltured**; change the names to yours.

| What | Entity (for a screen called "Cafe wall") |
|---|---|
| Online | `binary_sensor.cafe_wall_online` |
| Playlist it plays | `sensor.cafe_wall_playlist` |
| File on screen | `sensor.cafe_wall_playing` |
| Choose its playlist | `select.cafe_wall_playlist_choice` (options: `Automatic` and the location's playlists) |
| Refresh | `button.cafe_wall_refresh` |
| The relay's link to the main server | `binary_sensor.qoltured_main_server_connected` |
| Screens online / offline | `sensor.qoltured_screens_online`, `sensor.qoltured_screens_offline` |

The easiest way to make these is in the automation editor (**Settings → Automations & scenes →
Create automation**). Switch to **Edit in YAML** to paste one of these.

A change reaches the TV at its next check-in, within a minute.

## Evening playlist at 18:00, back to normal at opening

The location needs a playlist called **Evening** (on the main server: Locations → Qoltured → New playlist).

```yaml
alias: "Cafe wall: evening playlist"
triggers:
  - trigger: time
    at: "18:00:00"
actions:
  - action: select.select_option
    target:
      entity_id: select.cafe_wall_playlist_choice
    data:
      option: Evening
```

```yaml
alias: "Cafe wall: back to the normal playlist"
triggers:
  - trigger: time
    at: "08:00:00"
actions:
  - action: select.select_option
    target:
      entity_id: select.cafe_wall_playlist_choice
    data:
      option: Automatic
```

## Several screens at once

The **Kiosk Player: Play playlist** action takes several screens. In the editor, pick them under
**Screens**; in YAML they are device ids, which the editor fills in for you.

```yaml
alias: "Qoltured: promo during lunch"
triggers:
  - trigger: time
    at: "12:00:00"
actions:
  - action: kiosk_player.play_playlist
    data:
      device_id:
        - 1a2b3c…   # Cafe wall (picked in the editor)
        - 4d5e6f…   # Counter
      playlist: Lunch promo
```

`playlist` is `Automatic`, a playlist's name, or its number. A name the screen's location doesn't
have is an error, and nothing changes.

## Tell me when a screen goes offline during opening hours

The main server can already send these (Settings → Notifications on the main server). This one is for
a site that wants its own, e.g. to the shop manager's phone.

```yaml
alias: "Cafe wall offline"
triggers:
  - trigger: state
    entity_id: binary_sensor.cafe_wall_online
    to: "off"
    for: "00:05:00"
conditions:
  - condition: time
    after: "08:00:00"
    before: "18:00:00"
    weekday: [mon, tue, wed, thu, fri, sat]
actions:
  - action: notify.mobile_app_managers_phone
    data:
      title: Kiosk
      message: "Cafe wall has been offline for 5 minutes."
```

## Tell me when this site loses the main server

```yaml
alias: "Qoltured can't reach the main Kiosk server"
triggers:
  - trigger: state
    entity_id: binary_sensor.qoltured_main_server_connected
    to: "off"
    for: "00:10:00"
actions:
  - action: notify.mobile_app_managers_phone
    data:
      message: "Qoltured can't reach the main Kiosk server. Its screens keep playing what they have."
```

## A button on the counter: show the promo now

Any button or switch Home Assistant knows can do it (here an input button on a dashboard).

```yaml
alias: "Promo button"
triggers:
  - trigger: state
    entity_id: input_button.show_promo
actions:
  - action: select.select_option
    target:
      entity_id: select.cafe_wall_playlist_choice
    data:
      option: Promo
  - delay: "00:30:00"
  - action: select.select_option
    target:
      entity_id: select.cafe_wall_playlist_choice
    data:
      option: Automatic
```

## Know when the TV has really picked it up

Every change is reported with the event `kiosk_player_command_updated`. Its `status` is `applied`
(the main server changed it), then `acknowledged` (the TV fetched it), or `expired` (the TV didn't check
in within 5 minutes; the change stays and the TV picks it up when it's back).

```yaml
alias: "Tell me if a screen didn't pick up a change"
triggers:
  - trigger: event
    event_type: kiosk_player_command_updated
    event_data:
      status: expired
actions:
  - action: persistent_notification.create
    data:
      message: "Screen {{ trigger.event.data.player_id }} didn't pick up a change within 5 minutes."
```

Other events: `kiosk_player_player_online`, `kiosk_player_player_offline` (with `player_id` and
`name`), and `kiosk_player_connection_changed` (with `connected`).

## A script to refresh every screen at the site

```yaml
alias: Refresh Qoltured screens
sequence:
  - action: button.press
    target:
      entity_id:
        - button.cafe_wall_refresh
        - button.counter_refresh
```
