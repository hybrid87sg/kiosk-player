package com.kiosk.player

import android.app.ActivityManager
import android.app.AlarmManager
import android.app.ApplicationExitInfo
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import android.util.Log
import kotlin.system.exitProcess

/**
 * Reopens the player when it has been closed without anyone asking: a crash,
 * or Android closing it to free memory.
 *
 * [KeepInFront] only works while the app is running. This uses an Android
 * alarm instead, which still fires after the app has been closed: about once
 * a minute it checks that the player is on screen, and opens it if not.
 * (Nothing survives a force stop, which also cancels alarms; setting the
 * player as the TV's home screen covers that, see [HomeScreen].)
 */
object Watchdog {
    private const val TAG = "KioskWatchdog"
    const val CHECK_EVERY_MS = 60_000L
    private const val AFTER_CRASH_MS = 3_000L
    /** After this many crashes in 10 minutes, wait [CRASH_LOOP_PAUSE_MS] before trying again. */
    private const val CRASH_LOOP_COUNT = 5
    private const val CRASH_LOOP_PAUSE_MS = 5 * 60_000L

    /** Sets the next check [delayMs] from now, replacing any earlier one. */
    fun arm(context: Context, delayMs: Long = CHECK_EVERY_MS) {
        val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = PendingIntent.getBroadcast(
            context, 1, Intent(context, WatchdogReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // Not a wake-up alarm: a sleeping TV (after hours) is left asleep.
        runCatching { alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + delayMs, intent) }
    }

    /** One check: open the player if it should be on screen and isn't. */
    fun check(context: Context) {
        arm(context)
        val now = System.currentTimeMillis()
        // Closed for a Restart from the dashboard (0.13.0): open it again straight away.
        if (!KeepInFront.onScreen && now - PlayerSettings(context).restartAskedAt < 60_000L) {
            PlayerSettings(context).restartAskedAt = 0L
            runCatching { KeepInFront.bringBack(context) }
            return
        }
        if (KeepInFront.onScreen || !KeepInFront.shouldReturn(context)) return
        // Someone just left the app: give them the usual 30 seconds (KeepInFront handles that).
        if (now - KeepInFront.leftAt < KeepInFront.RETURN_AFTER_MS) return
        // Asleep after hours: the opening-time alarm (AfterHours) wakes it and opens the player.
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!power.isInteractive) return
        val settings = PlayerSettings(context)
        if (settings.recentCrashes(now) >= CRASH_LOOP_COUNT && now - settings.lastCrashAt < CRASH_LOOP_PAUSE_MS) return
        Log.i(TAG, "Player isn't on screen: opening it")
        runCatching { KeepInFront.bringBack(context) }
    }

    /**
     * When the app crashes: remember why, ask the alarm to reopen it in a few
     * seconds, and end the process quietly (no "Kiosk Player has stopped" box
     * left on the screen).
     */
    fun installCrashHandler(context: Context) {
        val app = context.applicationContext
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            Log.e(TAG, "Crash on ${thread.name}", error)
            runCatching {
                val settings = PlayerSettings(app)
                val now = System.currentTimeMillis()
                settings.noteCrash("${error.javaClass.simpleName}: ${error.message.orEmpty()}".trimEnd(':', ' '), now)
                val looping = settings.recentCrashes(now) >= CRASH_LOOP_COUNT
                arm(app, if (looping) CRASH_LOOP_PAUSE_MS else AFTER_CRASH_MS)
            }
            Process.killProcess(Process.myPid())
            exitProcess(10)
        }
    }

    /**
     * Called when the app starts: if it last closed without being asked to,
     * saves a plain reason, which the heartbeat sends to the dashboard.
     */
    fun noteLastExit(context: Context) {
        val settings = PlayerSettings(context)
        val seenUntil = settings.exitInfoSeenUntil
        val now = System.currentTimeMillis()
        settings.exitInfoSeenUntil = now
        if (seenUntil == 0L) {
            // First start with this feature: only a crash from now on counts.
            if (settings.lastCrashAt == 0L) return
        }

        var best: Pair<String, Long>? = null
        val crashAt = settings.lastCrashAt
        if (crashAt > seenUntil) {
            best = "The app crashed (${settings.lastCrashText ?: "no details"})" to crashAt
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && seenUntil > 0L) {
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val exits = runCatching { am.getHistoricalProcessExitReasons(context.packageName, 0, 10) }.getOrDefault(emptyList())
            exits.asSequence()
                .filter { it.timestamp > seenUntil }
                // The crash handler's own exit, already explained above.
                .filterNot { crashAt > 0 && it.timestamp - crashAt in -1_000L..30_000L }
                .mapNotNull { info -> describe(info)?.let { it to info.timestamp } }
                .maxByOrNull { it.second }
                ?.let { if (best == null || it.second > best!!.second) best = it }
        }
        best?.let { (reason, at) ->
            Log.w(TAG, "Last closed by itself: $reason")
            settings.noteRestart(reason, at)
        }
    }

    /** Plain words for why Android closed the app; null when it was expected (an update, a normal exit). */
    private fun describe(info: ApplicationExitInfo): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val detail = info.description?.takeIf { it.isNotBlank() }?.let { " ($it)" }.orEmpty()
        return when (info.reason) {
            ApplicationExitInfo.REASON_LOW_MEMORY -> "Android closed it to free memory"
            ApplicationExitInfo.REASON_CRASH, ApplicationExitInfo.REASON_CRASH_NATIVE -> "The app crashed$detail"
            ApplicationExitInfo.REASON_ANR -> "The app stopped responding and Android closed it"
            ApplicationExitInfo.REASON_SIGNALED ->
                if (info.status == 9) "Android or another app ended it (often: the TV ran out of memory)"
                else "Android ended it (signal ${info.status})"
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "Android closed it for using too much memory or power$detail"
            ApplicationExitInfo.REASON_USER_REQUESTED, ApplicationExitInfo.REASON_USER_STOPPED ->
                "It was force-stopped (from the TV's settings, or by a cleaner app on the box)"
            ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "Android closed it after one of its permissions changed"
            ApplicationExitInfo.REASON_INITIALIZATION_FAILURE,
            ApplicationExitInfo.REASON_DEPENDENCY_DIED,
            ApplicationExitInfo.REASON_FREEZER,
            ApplicationExitInfo.REASON_OTHER -> "Android closed it$detail"
            else -> null // EXIT_SELF, PACKAGE_UPDATED, PACKAGE_STATE_CHANGE, UNKNOWN
        }
    }
}

/** The watchdog's alarm. Android starts the app (if it was closed) to deliver it. */
class WatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = Watchdog.check(context)
}
