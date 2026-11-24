# Overlays on top of the playlist

**Status:** planned, not built. Planned on 13 Nov 2026, after Kiosk Signage 0.6.0.

Pictures and announcements shown on top of what a screen is playing, set per location.

## Decided

- **Set per location**, on the Locations page, beside the location's Landscape and
  Portrait playlists. Every screen in the location shows them.
- **One screen can opt out**, with a switch in its Edit form: *Show this location's overlays*.
- **Two kinds** (a scrolling text ticker and a clock/weather corner were offered and not chosen):

### Logo or image

- Any picture from the Library. A PNG with a transparent background suits logos,
  "Sale" badges and QR codes.
- Position: a corner (top-left, top-right, bottom-left, bottom-right) or centred.
- Size: small, medium or large.
- Shown always, or between a start and end date (like files).
- Several at once is fine, e.g. a logo in one corner and a QR code in another.
- Stays in the same corner of the picture people see, on turned and upside-down screens too.
- The playlist keeps playing underneath.

### Timed announcement

- A picture or a video from the Library.
- Full screen, or a banner across the bottom or top.
- Shown in a one-off window (e.g. 24 Dec 18:00–18:15) or every day at a set time
  (e.g. 21:45–22:00, "Closing soon").
- Only during the location's working hours; a dark (closed) screen does not wake up for it.

### Full-screen announcements pause the playlist

- While a **full-screen** announcement is on, the video underneath **pauses where it is**,
  and a picture item's timer stops.
- When the announcement ends, the playlist **carries on from the exact spot**, rather than
  starting that item again.
- A **banner** covers only part of the screen, so the playlist keeps playing under it.
- A video announcement shorter than its window loops until the window closes.

## How it would work

- **Server:** overlay settings stored per location and sent to each screen with its playlist.
- **TV app:**
  - draws the overlays on top of playback;
  - pauses and resumes the playlist around full-screen announcements;
  - switches announcements on and off by its own clock, so it works while offline;
  - downloads overlay files ahead of time, like upcoming playlist files.
  The storage cleanup keeps overlay files until their end date.
- **Web page:** an Overlays section on each location, with a picker for the file, and settings
  for position, size and schedule.
- **Phone app:** shows a location's overlays, read-only. Editing is on the web page.
- **Versions:** add-on and TV app go up a version (0.7.0 or later). The phone app needs a
  small update.

## Open questions

1. **Sound:** should a video announcement play with sound? Playlist videos are silent today.
2. **Text announcements:** should people be able to type an announcement on the page
   (e.g. "Closing in 15 minutes", in the house colours) without making a picture first?
3. **Mock-up first:** a picture of the Overlays section and of a screen with a logo and a
   banner, before building?
