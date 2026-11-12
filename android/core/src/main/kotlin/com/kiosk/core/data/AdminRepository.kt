// Everything the admin app can ask for. The screens only talk to this
// interface, so they work the same with the real server (RemoteAdminRepository)
// and with the built-in sample data (DemoAdminRepository).
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
import com.kiosk.core.model.Session
import com.kiosk.core.model.User
import com.kiosk.core.model.WaitingDevice
import java.io.InputStream

interface AdminRepository {
    val isDemo: Boolean

    /** Signs in with a username and password made on the server's Users page. */
    suspend fun signIn(username: String, password: String): Session
    suspend fun signOut()

    suspend fun library(): Library
    suspend fun syncLibrary(): Library
    /**
     * [startsAt]: when the file starts showing (unix ms), or null for straight away.
     * [expiresAt]: when it leaves Kiosk, or null for never.
     */
    suspend fun upload(file: UploadSource, startsAt: Long? = null, expiresAt: Long? = null, onProgress: (Float) -> Unit): Media
    suspend fun setMediaSchedule(id: Long, startsAt: Long?, expiresAt: Long?): Media
    /** "Remove from Kiosk": out of the library, playlists and screens. Google Drive keeps the file. */
    suspend fun deleteMedia(id: Long)
    /** Brings an expired or removed file back into the library (not into playlists). */
    suspend fun restoreMedia(id: Long, startsAt: Long?, expiresAt: Long?): Media

    suspend fun playlists(): List<PlaylistSummary>
    suspend fun playlist(id: Long): PlaylistDetail
    /** An extra playlist for a location, besides its automatic two. */
    suspend fun createPlaylist(name: String, orientation: ScreenShape, locationId: Long): PlaylistDetail
    suspend fun updatePlaylist(id: Long, name: String, orientation: ScreenShape): PlaylistDetail
    suspend fun savePlaylistItems(id: Long, items: List<PlaylistEntry>): PlaylistDetail
    suspend fun deletePlaylist(id: Long)

    suspend fun devices(): List<Device>
    /** TVs showing a pairing code right now, so they can be added without scanning or typing. */
    suspend fun waitingDevices(): List<WaitingDevice>
    /** [code] is what the QR code says ("kiosk-pair:K7P29Q") or what was typed ("k7p-29q"). */
    suspend fun claimDevice(code: String, setup: PlayerSetup): Device
    suspend fun updateDevice(id: Long, setup: PlayerSetup): Device
    suspend fun removeDevice(id: Long)

    suspend fun users(): List<User>
    /** Makes someone who can sign in. The password needs at least 8 characters. */
    suspend fun addUser(username: String, role: Role, password: String): User
    /** Gives someone a new password, which signs them out everywhere. */
    suspend fun setPassword(id: Long, password: String): User
    suspend fun changeRole(id: Long, role: Role): User
    suspend fun removeUser(id: Long)
}

/**
 * A file picked on the phone. [open] gives its bytes; [width]/[height] are
 * only used by Demo mode (the real server gets the size from Google Drive).
 */
class UploadSource(
    val name: String,
    val mime: String,
    val size: Long,
    val width: Int? = null,
    val height: Int? = null,
    val open: () -> InputStream,
)
