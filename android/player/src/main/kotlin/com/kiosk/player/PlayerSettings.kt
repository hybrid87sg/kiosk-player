package com.kiosk.player

import android.content.Context
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

    fun clear() = prefs.edit().clear().apply()
}
