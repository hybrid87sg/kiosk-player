# Kiosk Signage Server

The server that **Kiosk Admin** (phone) and **Kiosk Player** (TV) connect to. It
remembers your playlists, players and users, and passes your videos and pictures
from Google Drive to the TVs.

## Before you start

You need the one-time Google setup, which gives you:

- **Spongebob account email**: your Google account.
- **Google web client ID**: from Google Cloud Console, ending in `.apps.googleusercontent.com`.
- **Google Drive folder ID**: the last part of the Signage folder's web address.
- **The service account key file** (a `.json` file).

## Install

1. Install the **Samba share** add-on (Settings → Add-ons → Add-on store) and
   start it, so you can copy files to Home Assistant from your computer.
2. Copy the whole `kiosk_server` folder into the **addons** share.
3. Go to Settings → Add-ons → Add-on store, open the ⋮ menu (top right),
   choose **Check for updates**, and find **Kiosk Signage Server** under
   **Local add-ons**. Click **Install**. Building takes a few minutes.
4. Start the add-on once. It stops straight away and its log asks for settings;
   this also creates its config folder.
5. Copy your service account key into the **addon_configs** share, inside the
   `local_kiosk_server` folder, and name it `service-account.json`.
6. Open the add-on's **Configuration** tab, fill in the settings, click **Save**,
   then **Start**. The **Log** tab should say `Kiosk server running on port 3000`.
7. Switch on **Start on boot** and **Watchdog**.

## The web interface: the main control

- **In Home Assistant:** open **Kiosk Signage** in the sidebar. It's for Home Assistant admins, who get
  full (Spongebob) access.
- **In any browser:** go to `http://<address>:3000`, or click **Open web UI** on this add-on's page.
  People you invited sign in with Google using a code from google.com/device; they don't need a Home
  Assistant account. This needs the two optional **Web sign-in client** settings.

## Files, expiry dates and Google Drive

Each file can have an expiry date (Library → calendar button). After that day it leaves Kiosk, every
playlist and every screen; it waits under **Expired and removed**, where it can be restored. Kiosk never
deletes anything from Google Drive: expired and removed files stay in the shared drive.

## Adding TVs

On each TV, open Kiosk Player and choose **Find my server automatically**. The TV then shows up on the
web interface's Screens page under **New screens waiting**; click **Add**. The TV must be on the same
network as Home Assistant. If it can't find the server, type `http://<Home Assistant's IP address>:3000`
instead (Settings → System → Network shows the IP address).

For the phone app, use your Home Assistant's Tailscale address plus `:3000`.

## Other sites (relay mode)

With Home Assistants at several sites, keep this add-on in **main** mode on one of them. At each other
site, install the Tailscale add-on (with userspace networking off) and this add-on in **relay** mode, with
that site's **Site name** and the main server's Tailscale address (e.g. `100.101.102.103:3000`). A relay
needs no Google settings. Its TVs find it by themselves and show up on the main web interface, labelled
with their site.

## Managing screens away from home

Your phone needs a way into your home network. The simplest is the **Tailscale**
add-on plus the Tailscale app on your phone. Then use the Home Assistant
machine's Tailscale address in Kiosk Admin.

## Keep a local copy of each file

With **Keep a local copy of each file** on, each file is downloaded from Google
Drive once and then sent to every TV from this machine, which saves internet
data and is faster. The copies are stored in this add-on's data folder and are
deleted automatically when a file is removed from the library.
