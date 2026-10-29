# Test signing key

`kiosk-debug.keystore` signs the **test builds** of Kiosk Admin and Kiosk Player
(password `android`, alias `androiddebugkey`). It is committed on purpose so every
build has the same fingerprint, which Google sign-in needs:

- SHA-1: `C6:6E:87:04:EF:4A:7E:5C:34:5C:2A:74:CE:66:54:92:40:4E:37:26`

Before the apps are ever published, make a separate release key and keep it secret.
