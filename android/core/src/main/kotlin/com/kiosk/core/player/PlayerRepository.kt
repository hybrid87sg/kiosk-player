package com.kiosk.core.player

import com.kiosk.core.model.PlayerPlaylist
import com.kiosk.core.model.PlayerStatus
import com.kiosk.core.model.Registration
import com.kiosk.core.network.AppVersionBody
import com.kiosk.core.network.HeartbeatBody
import com.kiosk.core.network.PlayerApi
import com.kiosk.core.network.ServerConnection
import com.kiosk.core.network.apiCall
import okhttp3.OkHttpClient

/** What the TV player asks the server. */
interface PlayerRepository {
    suspend fun register(appVersion: String): Registration
    suspend fun status(): PlayerStatus
    suspend fun playlist(): PlayerPlaylist
    /** Reports "I'm alive"; returns the server's current playlist version. */
    suspend fun heartbeat(currentMediaId: Long?, freeBytes: Long?, appVersion: String): String?
}

/** The real server. [token] is the TV's saved secret, null before registering. */
class RemotePlayerRepository(serverUrl: String, @Volatile var token: String?) : PlayerRepository {
    private val connection = ServerConnection(serverUrl) { token }
    private val api: PlayerApi = connection.create()

    /** Used for downloading files; it sends the TV's token automatically. */
    val httpClient: OkHttpClient get() = connection.client
    val baseUrl: String get() = connection.baseUrl

    override suspend fun register(appVersion: String): Registration =
        apiCall { api.register(AppVersionBody(appVersion)) }.also { token = it.token }

    override suspend fun status(): PlayerStatus = apiCall { api.status() }
    override suspend fun playlist(): PlayerPlaylist = apiCall { api.playlist() }

    override suspend fun heartbeat(currentMediaId: Long?, freeBytes: Long?, appVersion: String): String? =
        apiCall { api.heartbeat(HeartbeatBody(currentMediaId, freeBytes, appVersion)) }.version
}
