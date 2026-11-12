package com.kiosk.core.data

import com.kiosk.core.model.Device
import com.kiosk.core.model.Library
import com.kiosk.core.model.Media
import com.kiosk.core.model.PlayerSetup
import com.kiosk.core.model.PlaylistDetail
import com.kiosk.core.model.PlaylistEntry
import com.kiosk.core.model.PlaylistSummary
import com.kiosk.core.model.Role
import com.kiosk.core.model.ScreenShape
import com.kiosk.core.model.ServerConfig
import com.kiosk.core.model.Session
import com.kiosk.core.model.User
import com.kiosk.core.model.WaitingDevice
import com.kiosk.core.network.AdminApi
import com.kiosk.core.network.LoginBody
import com.kiosk.core.network.PasswordBody
import com.kiosk.core.network.ItemBody
import com.kiosk.core.network.ItemsBody
import com.kiosk.core.network.PlaylistBody
import com.kiosk.core.network.RoleBody
import com.kiosk.core.network.ServerConnection
import com.kiosk.core.network.UserBody
import com.kiosk.core.network.apiCall
import com.kiosk.core.network.deviceBody
import com.kiosk.core.network.scheduleBody
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody
import okio.BufferedSink
import java.net.URLEncoder

/**
 * Talks to the real Kiosk server at [serverUrl]. [token] is the saved sign-in
 * (or null); [onTokenChanged] is told when it changes so the app can save it.
 */
class RemoteAdminRepository(
    serverUrl: String,
    private var token: String?,
    private val onTokenChanged: (String?) -> Unit,
) : AdminRepository {
    private val api: AdminApi = ServerConnection(serverUrl) { token }.create()

    override val isDemo = false

    /** Checks the address really is a Kiosk server, and how it wants people to sign in. */
    suspend fun serverConfig(): ServerConfig = apiCall { api.config() }

    override suspend fun signIn(username: String, password: String): Session {
        val session = apiCall { api.signIn(LoginBody(username.trim(), password)) }
        token = session.token
        onTokenChanged(session.token)
        return session
    }

    override suspend fun signOut() {
        runCatching { apiCall { api.signOut() } } // sign out locally even if the server can't be reached
        token = null
        onTokenChanged(null)
    }

    override suspend fun library(): Library = apiCall { api.library() }
    override suspend fun syncLibrary(): Library = apiCall { api.syncLibrary() }

    override suspend fun upload(file: UploadSource, startsAt: Long?, expiresAt: Long?, onProgress: (Float) -> Unit): Media {
        // encodeURIComponent-style: the server decodes it with decodeURIComponent.
        val encodedName = URLEncoder.encode(file.name, "UTF-8").replace("+", "%20")
        return apiCall { api.upload(encodedName, startsAt?.toString(), expiresAt?.toString(), StreamingBody(file, onProgress)) }
    }

    override suspend fun setMediaSchedule(id: Long, startsAt: Long?, expiresAt: Long?): Media =
        apiCall { api.setSchedule(id, scheduleBody(startsAt, expiresAt)) }
    override suspend fun deleteMedia(id: Long) { apiCall { api.deleteMedia(id) } }
    override suspend fun restoreMedia(id: Long, startsAt: Long?, expiresAt: Long?): Media =
        apiCall { api.restoreMedia(id, scheduleBody(startsAt, expiresAt)) }

    override suspend fun playlists(): List<PlaylistSummary> = apiCall { api.playlists() }
    override suspend fun playlist(id: Long): PlaylistDetail = apiCall { api.playlist(id) }

    override suspend fun createPlaylist(name: String, orientation: ScreenShape, locationId: Long): PlaylistDetail =
        apiCall { api.createPlaylist(PlaylistBody(name, orientation, locationId)) }

    override suspend fun updatePlaylist(id: Long, name: String, orientation: ScreenShape): PlaylistDetail =
        apiCall { api.updatePlaylist(id, PlaylistBody(name, orientation)) }

    override suspend fun savePlaylistItems(id: Long, items: List<PlaylistEntry>): PlaylistDetail =
        apiCall { api.saveItems(id, ItemsBody(items.map { ItemBody(it.mediaId, it.imageSeconds, it.startAt, it.endAt) })) }

    override suspend fun deletePlaylist(id: Long) { apiCall { api.deletePlaylist(id) } }

    override suspend fun devices(): List<Device> = apiCall { api.devices() }
    override suspend fun waitingDevices(): List<WaitingDevice> = apiCall { api.waitingDevices() }

    override suspend fun claimDevice(code: String, setup: PlayerSetup): Device =
        apiCall { api.claim(deviceBody(code, setup)) }

    override suspend fun updateDevice(id: Long, setup: PlayerSetup): Device =
        apiCall { api.updateDevice(id, deviceBody(code = null, setup)) }

    override suspend fun removeDevice(id: Long) { apiCall { api.deleteDevice(id) } }

    override suspend fun users(): List<User> = apiCall { api.users() }
    override suspend fun addUser(username: String, role: Role, password: String): User =
        apiCall { api.addUser(UserBody(username.trim(), role, password)) }
    override suspend fun setPassword(id: Long, password: String): User = apiCall { api.setPassword(id, PasswordBody(password)) }
    override suspend fun changeRole(id: Long, role: Role): User = apiCall { api.changeRole(id, RoleBody(role)) }
    override suspend fun removeUser(id: Long) { apiCall { api.deleteUser(id) } }

}

/**
 * Sends a picked file to the server without loading it all into memory:
 * it reads 64 KB at a time and reports how far it has got.
 */
private class StreamingBody(
    private val file: UploadSource,
    private val onProgress: (Float) -> Unit,
) : RequestBody() {
    override fun contentType(): MediaType? = file.mime.toMediaTypeOrNull()
    override fun contentLength(): Long = if (file.size > 0) file.size else -1
    override fun isOneShot(): Boolean = true

    override fun writeTo(sink: BufferedSink) {
        val buffer = ByteArray(64 * 1024)
        var sent = 0L
        file.open().use { input ->
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                sink.write(buffer, 0, read)
                sent += read
                if (file.size > 0) onProgress((sent.toFloat() / file.size).coerceAtMost(1f))
            }
        }
    }
}
