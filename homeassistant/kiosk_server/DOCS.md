# Kiosk Signage Server

The server that **Kiosk Admin** (phone) and **Kiosk Player** (TV) connect to. It
remembers your playlists, players and users, and passes your videos and pictures
from Google Drive to the TVs.

## Before you start

You need the one-time Google setup, which gives you:

- **Superadmin email**: your Google account.
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

## Connecting the apps

In Kiosk Admin and Kiosk Player, enter the server address:

```
http://<your Home Assistant's IP address>:3000
```

for example `http://192.168.1.20:3000`. Find the IP address under
Settings → System → Network. The phone and TVs must be on the same network.

## The web interface

- **In Home Assistant:** open **Kiosk Signage** in the sidebar. It's for Home Assistant admins, who get
  full (superadmin) access.
- **In any browser:** go to `http://<address>:3000`. People sign in with Google using a code from
  google.com/device. This needs the two optional **Web sign-in client** settings.

## Managing screens away from home

Your phone needs a way into your home network. The simplest is the **Tailscale**
add-on plus the Tailscale app on your phone. Then use the Home Assistant
machine's Tailscale address in Kiosk Admin.

## Keep a local copy of each file

With **Keep a local copy of each file** on, each file is downloaded from Google
Drive once and then sent to every TV from this machine, which saves internet
data and is faster. The copies are stored in this add-on's data folder and are
deleted automatically when a file is removed from the library.
