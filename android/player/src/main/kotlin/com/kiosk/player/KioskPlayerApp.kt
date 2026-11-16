package com.kiosk.player

import android.app.Application

/** Runs whenever Android starts the app: from the screen, on boot, or for the watchdog's alarm. */
class KioskPlayerApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Watchdog.installCrashHandler(this)
        KeepInFront.load(this)
        Watchdog.noteLastExit(this)
        Watchdog.arm(this)
    }
}
