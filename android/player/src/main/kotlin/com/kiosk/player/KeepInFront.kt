package com.kiosk.player

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings

/**
 * Brings Kiosk Player back to the front when someone leaves it (Home button,
 * another app), so the screen never stays on the TV menu.
 *
 * Android only lets an app open itself from the background if it has the
 * "Display over other apps" permission. That permission is also what makes
 * starting on boot reliable on newer Android TV versions.
 */
object KeepInFront {
    const val RETURN_AFTER_MS = 30_000L
    private val handler = Handler(Looper.getMainLooper())
    private var pending: Runnable? = null

    /** "Leave for 15 minutes" sets this, so staff can use the TV box's settings. */
    @Volatile var pausedUntil = 0L
        private set

    fun hasPermission(context: Context): Boolean = Settings.canDrawOverlays(context)

    /** Called when the player goes to the background. */
    fun scheduleReturn(context: Context) {
        val app = context.applicationContext
        cancel()
        val delay = maxOf(RETURN_AFTER_MS, pausedUntil - System.currentTimeMillis())
        val task = Runnable {
            pending = null
            if (System.currentTimeMillis() < pausedUntil) {
                scheduleReturn(app) // still paused: check again later
            } else if (PlayerSettings(app).keepInFront && hasPermission(app)) {
                app.startActivity(
                    Intent(app, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
                )
            }
        }
        pending = task
        handler.postDelayed(task, delay)
    }

    /** Called when the player is on screen again. */
    fun cancel() {
        pending?.let(handler::removeCallbacks)
        pending = null
    }

    fun pauseFor(minutes: Int) {
        pausedUntil = System.currentTimeMillis() + minutes * 60_000L
    }

    fun resume() {
        pausedUntil = 0L
    }

    /**
     * Opens Android's "Display over other apps" screen for this app.
     * Returns false if this TV box hides that screen, in which case the
     * permission can be given from a computer with ADB (see [ADB_COMMAND]).
     */
    fun openPermissionScreen(activity: Activity): Boolean {
        val withPackage = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${activity.packageName}"))
        val general = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
        for (intent in listOf(withPackage, general)) {
            try {
                activity.startActivity(intent)
                return true
            } catch (e: ActivityNotFoundException) {
                // try the next one
            }
        }
        return false
    }

    const val ADB_COMMAND = "adb shell appops set com.kiosk.player SYSTEM_ALERT_WINDOW allow"
}
