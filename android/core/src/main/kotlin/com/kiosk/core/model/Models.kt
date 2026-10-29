// The shapes of the data the server sends and receives, as Kotlin classes.
// @SerialName gives the server's name for a field when it differs from ours
// (the server uses snake_case like "playlist_id"; Kotlin uses playlistId).
package com.kiosk.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class Role(val label: String) {
    @SerialName("superadmin") SUPERADMIN("Superadmin"),
    @SerialName("system_manager") SYSTEM_MANAGER("System manager"),
    @SerialName("content_uploader") CONTENT_UPLOADER("Content uploader");

    val canManagePlayers: Boolean get() = this != CONTENT_UPLOADER
    val canManageUsers: Boolean get() = this == SUPERADMIN
}

/** The shape of a file or a playlist. */
@Serializable
enum class ScreenShape(val label: String) {
    @SerialName("landscape") LANDSCAPE("Landscape"),
    @SerialName("portrait") PORTRAIT("Portrait"),
}

/** How a TV is mounted on the wall. The player turns the picture to match. */
@Serializable
enum class Mounting(val label: String, val shape: ScreenShape, val rotationDegrees: Int) {
    @SerialName("landscape") LANDSCAPE("Landscape", ScreenShape.LANDSCAPE, 0),
    @SerialName("portrait_right") PORTRAIT_RIGHT("Portrait, turned right", ScreenShape.PORTRAIT, 90),
    @SerialName("portrait_left") PORTRAIT_LEFT("Portrait, turned left", ScreenShape.PORTRAIT, 270),
}

@Serializable
enum class MediaType {
    @SerialName("video") VIDEO,
    @SerialName("image") IMAGE,
}

// ---------- Admin app ----------

/** Public settings from the server, read before signing in. */
@Serializable
data class ServerConfig(@SerialName("google_web_client_id") val googleWebClientId: String? = null)

@Serializable
data class Session(val token: String, val email: String, val role: Role)

@Serializable
data class Media(
    val id: Long,
    val filename: String,
    val type: MediaType,
    val mime: String,
    val size: Long,
    val md5: String,
    val width: Int? = null,
    val height: Int? = null,
    /** null while Drive is still working out the file's size. */
    val orientation: ScreenShape? = null,
    @SerialName("created_at") val createdAt: Long = 0,
)

@Serializable
data class Library(
    val items: List<Media>,
    @SerialName("synced_at") val syncedAt: Long? = null,
    @SerialName("sync_error") val syncError: String? = null,
)

@Serializable
data class DeviceRef(val id: Long, val name: String? = null)

@Serializable
data class PlaylistSummary(
    val id: Long,
    val name: String,
    val orientation: ScreenShape,
    val version: Int,
    @SerialName("item_count") val itemCount: Int,
    val devices: List<DeviceRef> = emptyList(),
)

@Serializable
data class PlaylistItem(
    @SerialName("media_id") val mediaId: Long,
    @SerialName("image_seconds") val imageSeconds: Int = 10,
    val filename: String,
    val type: MediaType,
    val mime: String = "",
    val size: Long = 0,
    val md5: String = "",
    val orientation: ScreenShape? = null,
)

@Serializable
data class PlaylistDetail(
    val id: Long,
    val name: String,
    val orientation: ScreenShape,
    val version: Int,
    @SerialName("item_count") val itemCount: Int,
    val devices: List<DeviceRef> = emptyList(),
    val items: List<PlaylistItem> = emptyList(),
)

@Serializable
data class Device(
    val id: Long,
    val name: String? = null,
    val location: String? = null,
    val orientation: Mounting = Mounting.LANDSCAPE,
    @SerialName("playlist_id") val playlistId: Long? = null,
    @SerialName("playlist_name") val playlistName: String? = null,
    val online: Boolean = false,
    @SerialName("last_seen") val lastSeen: Long? = null,
    @SerialName("current_filename") val currentFilename: String? = null,
    @SerialName("free_bytes") val freeBytes: Long? = null,
    @SerialName("app_version") val appVersion: String? = null,
)

@Serializable
data class User(
    val id: Long,
    val email: String,
    val role: Role,
    @SerialName("created_at") val createdAt: Long = 0,
)

/** Everything needed to set up a player, when pairing it or editing it later. */
data class PlayerSetup(
    val name: String,
    val location: String?,
    val orientation: Mounting,
    val playlistId: Long?,
)

/** One item when saving a playlist. */
data class PlaylistEntry(val mediaId: Long, val imageSeconds: Int)

// ---------- Player app ----------

@Serializable
data class Registration(
    val token: String,
    @SerialName("pairing_code") val pairingCode: String,
    @SerialName("qr_payload") val qrPayload: String,
)

@Serializable
data class PlayerStatus(
    val claimed: Boolean,
    val name: String? = null,
    @SerialName("pairing_code") val pairingCode: String? = null,
    @SerialName("qr_payload") val qrPayload: String? = null,
)

@Serializable
data class PlayerItem(
    val id: Long,
    val type: MediaType,
    val filename: String,
    val url: String,
    val md5: String,
    val size: Long,
    val orientation: ScreenShape? = null,
    @SerialName("duration_seconds") val durationSeconds: Int? = null,
)

@Serializable
data class PlayerPlaylist(
    val version: String,
    val name: String? = null,
    val orientation: Mounting = Mounting.LANDSCAPE,
    @SerialName("playlist_name") val playlistName: String? = null,
    val items: List<PlayerItem> = emptyList(),
)
