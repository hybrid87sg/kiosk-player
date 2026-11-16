// The shapes of the data the server sends and receives, as Kotlin classes.
// @SerialName gives the server's name for a field when it differs from ours
// (the server uses snake_case like "playlist_id"; Kotlin uses playlistId).
package com.kiosk.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class Role(val label: String) {
    @SerialName("superadmin") SUPERADMIN("Spongebob"),
    @SerialName("system_manager") SYSTEM_MANAGER("Patrick"),
    @SerialName("content_uploader") CONTENT_UPLOADER("Squidward");

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

    /**
     * A landscape screen mounted upside down. The server never sends this name: it sends
     * "landscape" with a separate "flipped" flag, so apps from before this still work.
     * See [mountingOf].
     */
    @SerialName("landscape_flipped") LANDSCAPE_FLIPPED("Landscape, upside down", ScreenShape.LANDSCAPE, 180),
}

/** Puts the server's orientation and its "flipped" flag together. */
fun mountingOf(orientation: Mounting, flipped: Boolean): Mounting =
    if (flipped && orientation == Mounting.LANDSCAPE) Mounting.LANDSCAPE_FLIPPED else orientation

/** The orientation to send to the server; upside down travels as a flag beside it. */
val Mounting.serverOrientation: Mounting get() = if (this == Mounting.LANDSCAPE_FLIPPED) Mounting.LANDSCAPE else this
val Mounting.isFlipped: Boolean get() = this == Mounting.LANDSCAPE_FLIPPED

@Serializable
enum class MediaType {
    @SerialName("video") VIDEO,
    @SerialName("image") IMAGE,
}

// ---------- Admin app ----------

/** Public settings from the server, read before signing in. */
@Serializable
data class ServerConfig(
    /** "password" from server 0.6.0 on: sign in with a username and password. Null on older servers. */
    @SerialName("sign_in") val signIn: String? = null,
    /** "kiosk-signage" for a Kiosk server; used when a TV searches the network. */
    val kind: String? = null,
    /** "main" (manages everything) or "relay" (passes one site's TVs to the main server). */
    val role: String? = null,
    @SerialName("server_id") val serverId: String? = null,
    @SerialName("site_name") val siteName: String? = null,
)

/** [email] holds the username: the server still sends it under that name too. */
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
    /** Set when this video may not play smoothly on some TV boxes. */
    @SerialName("playback_warning") val playbackWarning: String? = null,
    /** When the file starts showing on screens (unix ms); null = straight away. */
    @SerialName("starts_at") val startsAt: Long? = null,
    /** When the file leaves Kiosk and every screen (unix ms); null = never. Google Drive keeps it. */
    @SerialName("expires_at") val expiresAt: Long? = null,
)

/** A file taken out of Kiosk (it expired, or someone removed it). It's still in Google Drive. */
@Serializable
data class RemovedMedia(
    val id: Long,
    val filename: String,
    val type: MediaType,
    val size: Long = 0,
    val orientation: ScreenShape? = null,
    @SerialName("removed_at") val removedAt: Long,
    /** "expired" or "removed". */
    @SerialName("removed_reason") val removedReason: String,
) {
    val expired: Boolean get() = removedReason == "expired"
}

@Serializable
data class Library(
    val items: List<Media>,
    @SerialName("synced_at") val syncedAt: Long? = null,
    @SerialName("sync_error") val syncError: String? = null,
    /** "Expired and removed": can be restored. */
    val removed: List<RemovedMedia> = emptyList(),
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
    /** The location it belongs to; null when [unassigned]. */
    @SerialName("location_id") val locationId: Long? = null,
    /** That location's name. */
    val location: String? = null,
    /** One of a location's two automatic playlists (Landscape, Portrait), which its screens follow. */
    val auto: Boolean = false,
    /** It belongs to no location, so no screen plays it. */
    val unassigned: Boolean = false,
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
    @SerialName("start_at") val startAt: Long? = null,
    @SerialName("end_at") val endAt: Long? = null,
    /** The file's own dates (see [Media.startsAt] and [Media.expiresAt]). */
    @SerialName("starts_at") val startsAt: Long? = null,
    @SerialName("expires_at") val expiresAt: Long? = null,
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
    @SerialName("location_id") val locationId: Long? = null,
    val location: String? = null,
    val auto: Boolean = false,
    val unassigned: Boolean = false,
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
    /** The TV box, e.g. "Xiaomi MIBOX4". */
    val model: String? = null,
    /** Which site (Home Assistant) the TV is at, when there are several. */
    val site: String? = null,
    @SerialName("location_id") val locationId: Long? = null,
    /** The location's working hours, e.g. "Mon–Fri 08:00–18:00". */
    @SerialName("hours_summary") val hoursSummary: String? = null,
    /** False outside working hours (the screen is dark then). */
    @SerialName("open_now") val openNow: Boolean = true,
    /** What the TV does after hours: "black" or "standby". */
    @SerialName("after_hours") val afterHours: String? = null,
    /** Last playback failure reported by the TV, if it is still failing. */
    @SerialName("playback_error") val playbackError: String? = null,
    /** When the TV's app last closed by itself (and reopened), if in the past week. */
    @SerialName("last_restart") val lastRestart: LastRestart? = null,
    /** What the TV said it can decode, from its last heartbeat. */
    val decoders: DeviceCapabilities? = null,
    /** A landscape screen mounted upside down. Use [mounting] to read it. */
    val flipped: Boolean = false,
    /** False when the TV's app is too old to turn the picture upside down. */
    @SerialName("can_flip") val canFlip: Boolean = true,
    /** True when the screen follows its location's Landscape or Portrait playlist ([playlistId] is null). */
    @SerialName("playlist_auto") val playlistAuto: Boolean = false,
) {
    /** How the screen is mounted, including upside down. */
    val mounting: Mounting get() = mountingOf(orientation, flipped)
}

/** A TV showing its pairing code right now, waiting to be added. */
@Serializable
data class WaitingDevice(
    val id: Long,
    val model: String? = null,
    val site: String? = null,
    @SerialName("pairing_code") val pairingCode: String,
    @SerialName("last_seen") val lastSeen: Long? = null,
)

@Serializable
data class User(
    val id: Long,
    /** The username people sign in with (the server sends it as "email" as well as "username"). */
    val email: String,
    val role: Role,
    @SerialName("created_at") val createdAt: Long = 0,
    /** False for someone who can't sign in until they are given a password. */
    @SerialName("has_password") val hasPassword: Boolean = true,
)

/** Everything needed to set up a player, when pairing it or editing it later. */
data class PlayerSetup(
    val name: String,
    val location: String?,
    /** May be [Mounting.LANDSCAPE_FLIPPED]. */
    val orientation: Mounting,
    /** Null = Automatic: follow the location's Landscape or Portrait playlist. */
    val playlistId: Long?,
)

/** One item when saving a playlist. */
data class PlaylistEntry(
    val mediaId: Long,
    val imageSeconds: Int,
    val startAt: Long? = null,
    val endAt: Long? = null,
)

// ---------- Player app ----------

/** What a TV box reports about its screen and hardware decoders. */
@Serializable
data class DeviceCapabilities(
    @SerialName("display_width") val displayWidth: Int = 0,
    @SerialName("display_height") val displayHeight: Int = 0,
    /** H.264 level times 10, so 41 means level 4.1. Null if the box didn't say. */
    @SerialName("h264_level") val h264Level: Int? = null,
    @SerialName("h264_max_long") val h264MaxLong: Int? = null,
    @SerialName("h264_max_short") val h264MaxShort: Int? = null,
    val hevc: Boolean = false,
    @SerialName("hevc_max_long") val hevcMaxLong: Int? = null,
    @SerialName("hevc_max_short") val hevcMaxShort: Int? = null,
)

/** H.264 level as people write it: 41 is "4.1", 9 is the odd one, "1b". */
fun formatH264Level(level: Int): String = if (level == 9) "1b" else "${level / 10}.${level % 10}"

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
    /** Files starting within a day: download them ahead, but don't play them yet. */
    val upcoming: List<PlayerItem> = emptyList(),
    /** The location's working hours ("mon"…"sun"); null = always on. */
    val hours: Map<String, DayHours?>? = null,
    /** A landscape screen mounted upside down. Use [mounting] to read it. */
    val flipped: Boolean = false,
) {
    val mounting: Mounting get() = mountingOf(orientation, flipped)
}

/** Opening and closing time on one day, e.g. "08:00" and "18:00". */
@Serializable
data class DayHours(val open: String, val close: String)

/** The TV's app closed without being asked to (crash, out of memory…) and reopened. */
@Serializable
data class LastRestart(val reason: String, val at: Long)
