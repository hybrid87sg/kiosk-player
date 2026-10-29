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
import java.io.InputStream

interface AdminRepository {
    val isDemo: Boolean

    suspend fun signInWithGoogle(idToken: String): Session
    suspend fun signOut()

    suspend fun library(): Library
    suspend fun syncLibrary(): Library
    suspend fun upload(file: UploadSource, onProgress: (Float) -> Unit): Media
    suspend fun deleteMedia(id: Long)

    suspend fun playlists(): List<PlaylistSummary>
    suspend fun playlist(id: Long): PlaylistDetail
    suspend fun createPlaylist(name: String, orientation: ScreenShape): PlaylistDetail
    suspend fun updatePlaylist(id: Long, name: String, orientation: ScreenShape): PlaylistDetail
    suspend fun savePlaylistItems(id: Long, items: List<PlaylistEntry>): PlaylistDetail
    suspend fun deletePlaylist(id: Long)

    suspend fun devices(): List<Device>
    /** [code] is what the QR code says ("kiosk-pair:K7P29Q") or what was typed ("k7p-29q"). */
    suspend fun claimDevice(code: String, setup: PlayerSetup): Device
    suspend fun updateDevice(id: Long, setup: PlayerSetup): Device
    suspend fun removeDevice(id: Long)

    suspend fun users(): List<User>
    suspend fun inviteUser(email: String, role: Role): User
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
