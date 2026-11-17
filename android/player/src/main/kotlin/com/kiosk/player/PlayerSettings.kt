package com.kiosk.player

import android.content.Context
import com.kiosk.core.model.JobReport
import com.kiosk.core.model.Mounting
import com.kiosk.core.model.PlayerPlaylist
import kotlinx.serialization.json.Json

enum class PlayerMode { DEMO, SERVER }

/**
 * What the TV remembers between restarts: demo or server, the server address,
 * its secret token, and the last playlist (so it can play offline after a
 * power cut).
 */
class PlayerSettings(context: Context) {
    private val prefs = context.getSharedPreferences("kiosk-player", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    var mode: PlayerMode?
        get() = prefs.getString("mode", null)?.let { m -> PlayerMode.entries.firstOrNull { it.name == m } }
        set(value) = prefs.edit().putString("mode", value?.name).apply()

    var serverUrl: String?
        get() = prefs.getString("server_url", null)
        set(value) = prefs.edit().putString("server_url", value).apply()

    /** The server's own ID, so the TV can find it again if its address changes. */
    var serverId: String?
        get() = prefs.getString("server_id", null)
        set(value) = prefs.edit().putString("server_id", value).apply()

    var token: String?
        get() = prefs.getString("token", null)
        set(value) = prefs.edit().putString("token", value).apply()

    var cachedPlaylist: PlayerPlaylist?
        get() = prefs.getString("playlist", null)?.let { runCatching { json.decodeFromString(PlayerPlaylist.serializer(), it) }.getOrNull() }
        set(value) = prefs.edit().putString("playlist", value?.let { json.encodeToString(PlayerPlaylist.serializer(), it) }).apply()

    var demoMounting: Mounting
        get() = prefs.getString("demo_mounting", null)?.let { m -> Mounting.entries.firstOrNull { it.name == m } } ?: Mounting.LANDSCAPE
        set(value) = prefs.edit().putString("demo_mounting", value.name).apply()

    /** Come back to the front when someone leaves the app (needs "Display over other apps"). */
    var keepInFront: Boolean
        get() = prefs.getBoolean("keep_in_front", true)
        set(value) = prefs.edit().putBoolean("keep_in_front", value).apply()

    /**
     * "Leave for 15 minutes" ends at this time (unix ms). Saved, so a player
     * that Android closed and the watchdog reopened still leaves staff alone.
     */
    var pausedUntil: Long
        get() = prefs.getLong("paused_until", 0L)
        set(value) = prefs.edit().putLong("paused_until", value).apply()

    /** Why the app last closed without being asked to, e.g. "Android closed it to free memory". */
    val lastRestartReason: String? get() = prefs.getString("restart_reason", null)
    val lastRestartAt: Long? get() = prefs.getLong("restart_at", 0L).takeIf { it > 0 }

    fun noteRestart(reason: String, at: Long) {
        prefs.edit().putString("restart_reason", reason.take(300)).putLong("restart_at", at).apply()
    }

    /** The newest Android exit record already looked at, so each is reported once. */
    var exitInfoSeenUntil: Long
        get() = prefs.getLong("exit_seen_until", 0L)
        set(value) = prefs.edit().putLong("exit_seen_until", value).apply()

    /**
     * Written by the crash handler just before the app dies: saved straight
     * away ([commit]), since the process is about to end.
     */
    fun noteCrash(text: String, at: Long) {
        val recent = prefs.getString("crash_times", "").orEmpty().split(',').mapNotNull { it.toLongOrNull() }
            .filter { at - it < CRASH_WINDOW_MS }
        prefs.edit()
            .putString("crash_text", text.take(300))
            .putLong("crash_at", at)
            .putString("crash_times", (recent + at).joinToString(","))
            .commit()
    }

    val lastCrashText: String? get() = prefs.getString("crash_text", null)
    val lastCrashAt: Long get() = prefs.getLong("crash_at", 0L)

    /** How many times the app crashed in the last 10 minutes (to slow down a crash loop). */
    fun recentCrashes(now: Long): Int =
        prefs.getString("crash_times", "").orEmpty().split(',').mapNotNull { it.toLongOrNull() }.count { now - it < CRASH_WINDOW_MS }

    /** The latest step of an app update, written by the installer's answer too (0.11.0). */
    var updateReport: JobReport?
        get() = prefs.getString("update_report", null)?.let { runCatching { json.decodeFromString(JobReport.serializer(), it) }.getOrNull() }
        set(value) = prefs.edit()
            .putString("update_report", value?.let { json.encodeToString(JobReport.serializer(), it) })
            .putLong("update_report_at", System.currentTimeMillis())
            .commit().let { }
    val updateReportAt: Long get() = prefs.getLong("update_report_at", 0L)

    /** The last Reset sync finished, so a "done" that didn't reach the server isn't done twice. */
    var resyncDoneId: String?
        get() = prefs.getString("resync_done_id", null)
        set(value) = prefs.edit().putString("resync_done_id", value).apply()

    fun clear() = prefs.edit().clear().apply()

    companion object {
        const val CRASH_WINDOW_MS = 10 * 60_000L
    }
}
