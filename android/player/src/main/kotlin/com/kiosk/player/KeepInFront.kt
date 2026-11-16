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

    /**
     * "Leave for 15 minutes" sets this, so staff can use the TV box's settings.
     * Kept in [PlayerSettings] too, so it survives the app being closed.
     */
    @Volatile var pausedUntil = 0L
        private set

    /** True while the player is on screen. Starts false in a fresh process. */
    @Volatile var onScreen = false

    /** When the player last left the screen (0 in a fresh process). */
    @Volatile var leftAt = 0L

    /** Reads the saved pause once, when the app starts. */
    fun load(context: Context) {
        pausedUntil = PlayerSettings(context).pausedUntil
    }

    fun hasPermission(context: Context): Boolean = Settings.canDrawOverlays(context)

    /** Whether the player should be brought back now (on, allowed, not paused). */
    fun shouldReturn(context: Context): Boolean =
        System.currentTimeMillis() >= pausedUntil && PlayerSettings(context).keepInFront && hasPermission(context)

    /** Opens the player (from the background: needs "Display over other apps"). */
    fun bringBack(context: Context) {
        context.startActivity(
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
        )
    }

    /** Called when the player goes to the background. */
    fun scheduleReturn(context: Context) {
        val app = context.applicationContext
        cancel()
        val delay = maxOf(RETURN_AFTER_MS, pausedUntil - System.currentTimeMillis())
        val task = Runnable {
            pending = null
            if (System.currentTimeMillis() < pausedUntil) {
                scheduleReturn(app) // still paused: check again later
            } else if (shouldReturn(app)) {
                bringBack(app)
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

    fun pauseFor(context: Context, minutes: Int) {
        pausedUntil = System.currentTimeMillis() + minutes * 60_000L
        PlayerSettings(context).pausedUntil = pausedUntil
    }

    fun resume(context: Context) {
        pausedUntil = 0L
        PlayerSettings(context).pausedUntil = 0L
    }

    /** Opens the TV box's own settings (for staff, during "Leave for 15 minutes"). */
    fun openTvSettings(activity: Activity): Boolean = try {
        activity.startActivity(Intent(Settings.ACTION_SETTINGS))
        true
    } catch (e: ActivityNotFoundException) {
        false
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
