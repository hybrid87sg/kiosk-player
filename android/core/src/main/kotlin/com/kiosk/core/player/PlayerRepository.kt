package com.kiosk.core.player

import com.kiosk.core.model.DeviceCapabilities
import com.kiosk.core.model.DeviceReport
import com.kiosk.core.model.PlayerPlaylist
import com.kiosk.core.model.PlayerStatus
import com.kiosk.core.model.Registration
import com.kiosk.core.model.ServerConfig
import com.kiosk.core.network.AppVersionBody
import com.kiosk.core.network.HeartbeatBody
import com.kiosk.core.network.PlayerApi
import com.kiosk.core.network.ScreenshotBody
import com.kiosk.core.network.ServerConnection
import com.kiosk.core.network.apiCall
import okhttp3.OkHttpClient

/** What the TV player asks the server. */
interface PlayerRepository {
    /**
     * [model] is the TV box's make and model, shown while it waits to be added.
     * [decoders] is what it can play, so it gets playback copies that suit it.
     */
    suspend fun register(appVersion: String, model: String? = null, decoders: DeviceCapabilities? = null): Registration
    /** [mounting]: how staff turned the picture while it waits to be added (e.g. "portrait_right"). */
    suspend fun status(mounting: String? = null): PlayerStatus
    suspend fun playlist(): PlayerPlaylist
    /**
     * Reports "I'm alive"; returns the server's current playlist version.
     * [download] is (files done, total) while new files are downloading.
     * [timeZone] and [afterHours] ("black" or "standby") help the server judge working hours.
     */
    suspend fun heartbeat(
        currentMediaId: Long?,
        freeBytes: Long?,
        appVersion: String,
        download: Pair<Int, Int>? = null,
        timeZone: String? = null,
        afterHours: String? = null,
        decoders: DeviceCapabilities? = null,
        playbackError: String? = null,
        lastRestart: Pair<String, Long>? = null,
        report: DeviceReport? = null,
    ): String?

    /** See screen (0.13.0): sends the picture ([jpeg] bytes) or, if there isn't one, [error]. */
    suspend fun sendScreenshot(id: String, jpeg: ByteArray?, error: String? = null)
}

/** The real server. [token] is the TV's saved secret, null before registering. */
class RemotePlayerRepository(serverUrl: String, @Volatile var token: String?) : PlayerRepository {
    private val connection = ServerConnection(serverUrl) { token }
    private val api: PlayerApi = connection.create()

    /** Used for downloading files; it sends the TV's token automatically. */
    val httpClient: OkHttpClient get() = connection.client
    val baseUrl: String get() = connection.baseUrl

    override suspend fun register(appVersion: String, model: String?, decoders: DeviceCapabilities?): Registration =
        apiCall { api.register(AppVersionBody(appVersion, model, decoders)) }.also { token = it.token }

    /** Which server this is (its ID lets the TV find it again if its address changes). */
    suspend fun config(): ServerConfig = apiCall { api.config() }

    override suspend fun status(mounting: String?): PlayerStatus = apiCall { api.status(mounting) }
    override suspend fun playlist(): PlayerPlaylist = apiCall { api.playlist() }

    override suspend fun heartbeat(
        currentMediaId: Long?,
        freeBytes: Long?,
        appVersion: String,
        download: Pair<Int, Int>?,
        timeZone: String?,
        afterHours: String?,
        decoders: DeviceCapabilities?,
        playbackError: String?,
        lastRestart: Pair<String, Long>?,
        report: DeviceReport?,
    ): String? = apiCall {
        api.heartbeat(HeartbeatBody(
            currentMediaId, freeBytes, appVersion, download?.first, download?.second,
            timeZone = timeZone, afterHours = afterHours, decoders = decoders, playbackError = playbackError,
            lastRestartReason = lastRestart?.first, lastRestartAt = lastRestart?.second,
            androidSdk = report?.androidSdk, versionCode = report?.versionCode, canInstallApps = report?.canInstallApps,
            touchscreen = report?.touchscreen, webviewVersion = report?.webviewVersion, rotationSensor = report?.rotationSensor,
            canReboot = report?.canReboot, resync = report?.resync, update = report?.update, restart = report?.restart,
        ))
    }.version

    override suspend fun sendScreenshot(id: String, jpeg: ByteArray?, error: String?) {
        apiCall {
            api.screenshot(id, ScreenshotBody(
                jpeg = jpeg?.let { java.util.Base64.getEncoder().encodeToString(it) },
                error = if (jpeg == null) (error ?: "The screen couldn't take a picture.").take(300) else null,
            ))
        }
    }
}
