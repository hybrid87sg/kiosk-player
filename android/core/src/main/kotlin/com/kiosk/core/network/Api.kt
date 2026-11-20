// The server's web addresses, written as Kotlin functions. Retrofit turns each
// function into an HTTP request, e.g. getPlaylists() becomes GET /api/playlists.
package com.kiosk.core.network

import com.kiosk.core.model.Device
import com.kiosk.core.model.DeviceCapabilities
import com.kiosk.core.model.JobReport
import com.kiosk.core.model.Library
import com.kiosk.core.model.Media
import com.kiosk.core.model.Mounting
import com.kiosk.core.model.PlayerPlaylist
import com.kiosk.core.model.PlayerSetup
import com.kiosk.core.model.isFlipped
import com.kiosk.core.model.PlayerStatus
import com.kiosk.core.model.PlaylistDetail
import com.kiosk.core.model.PlaylistSummary
import com.kiosk.core.model.Registration
import com.kiosk.core.model.Role
import com.kiosk.core.model.ScreenShape
import com.kiosk.core.model.ServerConfig
import com.kiosk.core.model.Session
import com.kiosk.core.model.User
import com.kiosk.core.model.WaitingDevice
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.RequestBody
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path

internal interface AdminApi {
    @GET("api/config") suspend fun config(): ServerConfig
    @POST("api/auth/login") suspend fun signIn(@Body body: LoginBody): Session
    @POST("api/auth/logout") suspend fun signOut(): OkReply

    @GET("api/media") suspend fun library(): Library
    @POST("api/media/sync") suspend fun syncLibrary(): Library
    @POST("api/media") suspend fun upload(
        @Header("X-Filename") encodedName: String,
        @Header("X-Starts-At") startsAt: String?, // left out when null
        @Header("X-Expires-At") expiresAt: String?,
        @Body file: RequestBody,
    ): Media
    @PATCH("api/media/{id}") suspend fun setSchedule(@Path("id") id: Long, @Body body: JsonObject): Media
    @DELETE("api/media/{id}") suspend fun deleteMedia(@Path("id") id: Long): OkReply
    @POST("api/media/{id}/restore") suspend fun restoreMedia(@Path("id") id: Long, @Body body: JsonObject): Media

    @GET("api/playlists") suspend fun playlists(): List<PlaylistSummary>
    @GET("api/playlists/{id}") suspend fun playlist(@Path("id") id: Long): PlaylistDetail
    @POST("api/playlists") suspend fun createPlaylist(@Body body: PlaylistBody): PlaylistDetail
    @PATCH("api/playlists/{id}") suspend fun updatePlaylist(@Path("id") id: Long, @Body body: PlaylistBody): PlaylistDetail
    @PUT("api/playlists/{id}/items") suspend fun saveItems(@Path("id") id: Long, @Body body: ItemsBody): PlaylistDetail
    @DELETE("api/playlists/{id}") suspend fun deletePlaylist(@Path("id") id: Long): OkReply

    @GET("api/devices") suspend fun devices(): List<Device>
    @GET("api/devices/waiting") suspend fun waitingDevices(): List<WaitingDevice>
    @POST("api/devices/claim") suspend fun claim(@Body body: JsonObject): Device
    @PATCH("api/devices/{id}") suspend fun updateDevice(@Path("id") id: Long, @Body body: JsonObject): Device
    @DELETE("api/devices/{id}") suspend fun deleteDevice(@Path("id") id: Long): OkReply

    @GET("api/users") suspend fun users(): List<User>
    @POST("api/users") suspend fun addUser(@Body body: UserBody): User
    @PATCH("api/users/{id}") suspend fun setPassword(@Path("id") id: Long, @Body body: PasswordBody): User
    @PATCH("api/users/{id}") suspend fun changeRole(@Path("id") id: Long, @Body body: RoleBody): User
    @DELETE("api/users/{id}") suspend fun deleteUser(@Path("id") id: Long): OkReply
}

internal interface PlayerApi {
    @GET("api/config") suspend fun config(): ServerConfig
    @POST("api/player/register") suspend fun register(@Body body: AppVersionBody): Registration
    @GET("api/player/status") suspend fun status(@retrofit2.http.Query("mounting") mounting: String? = null): PlayerStatus
    @GET("api/player/playlist") suspend fun playlist(): PlayerPlaylist
    @POST("api/player/heartbeat") suspend fun heartbeat(@Body body: HeartbeatBody): HeartbeatReply
    /** See screen (0.13.0): the picture as a base64 JPEG, or why there isn't one. */
    @POST("api/player/screenshot/{id}") suspend fun screenshot(@Path("id") id: String, @Body body: ScreenshotBody): OkReply
}

// ---------- Request and reply bodies ----------

@Serializable internal data class OkReply(val ok: Boolean = true)
/**
 * A file's dates. Built by hand so an empty date is sent as null ("no date"),
 * which the server treats differently from leaving it out ("keep as it is").
 */
internal fun scheduleBody(startsAt: Long?, expiresAt: Long?): JsonObject = buildJsonObject {
    put("starts_at", startsAt)
    put("expires_at", expiresAt)
}
@Serializable internal data class LoginBody(val username: String, val password: String)
@Serializable internal data class PasswordBody(val password: String)
/** [locationId] is only sent for a new playlist; leaving it out keeps a playlist where it is. */
@Serializable
internal data class PlaylistBody(
    val name: String,
    val orientation: ScreenShape,
    @SerialName("location_id") val locationId: Long? = null,
)
@Serializable
internal data class ItemBody(
    @SerialName("media_id") val mediaId: Long,
    @SerialName("image_seconds") val imageSeconds: Int,
    @SerialName("start_at") val startAt: Long? = null,
    @SerialName("end_at") val endAt: Long? = null,
)
@Serializable internal data class ItemsBody(val items: List<ItemBody>)
@Serializable internal data class UserBody(val username: String, val role: Role, val password: String)
@Serializable internal data class RoleBody(val role: Role)
@Serializable
internal data class AppVersionBody(
    @SerialName("app_version") val appVersion: String,
    /** The TV box's make and model, shown while it waits to be added. */
    val model: String? = null,
    /** What this TV can decode, so it gets playback copies it can play. */
    val decoders: DeviceCapabilities? = null,
)

/**
 * A screen's settings. Built by hand so that "no location" and "no playlist of its own"
 * are sent as null, which the server treats differently from leaving them out
 * ("keep as it is"). Upside down is sent as a flag beside the orientation.
 */
internal fun deviceBody(code: String?, setup: PlayerSetup): JsonObject = buildJsonObject {
    if (code != null) put("code", code)
    put("name", setup.name)
    put("location", setup.location)
    put(
        "orientation",
        when (setup.orientation) {
            Mounting.LANDSCAPE, Mounting.LANDSCAPE_FLIPPED -> "landscape"
            Mounting.PORTRAIT_RIGHT -> "portrait_right"
            Mounting.PORTRAIT_LEFT -> "portrait_left"
        },
    )
    put("flipped", setup.orientation.isFlipped)
    put("playlist_id", setup.playlistId)
}

@Serializable
internal data class HeartbeatBody(
    @SerialName("current_media_id") val currentMediaId: Long?,
    @SerialName("free_bytes") val freeBytes: Long?,
    @SerialName("app_version") val appVersion: String,
    /** While new files download: how many are done, out of how many. */
    @SerialName("download_done") val downloadDone: Int? = null,
    @SerialName("download_total") val downloadTotal: Int? = null,
    /** This TV's time zone, so the server knows when its location is open for it. */
    @SerialName("time_zone") val timeZone: String? = null,
    /** What it does after hours: "black" or "standby". */
    @SerialName("after_hours") val afterHours: String? = null,
    val decoders: DeviceCapabilities? = null,
    /** Empty string clears a previous error. Omitted when the app doesn't know. */
    @SerialName("playback_error") val playbackError: String? = null,
    /** Why the app last closed without being asked to (crash, out of memory…), and when (unix ms). */
    @SerialName("last_restart_reason") val lastRestartReason: String? = null,
    @SerialName("last_restart_at") val lastRestartAt: Long? = null,
    @SerialName("android_sdk") val androidSdk: Int? = null,
    @SerialName("version_code") val versionCode: Int? = null,
    @SerialName("can_install_apps") val canInstallApps: Boolean? = null,
    val touchscreen: Boolean? = null,
    @SerialName("webview_version") val webviewVersion: String? = null,
    @SerialName("rotation_sensor") val rotationSensor: Boolean? = null,
    @SerialName("can_reboot") val canReboot: Boolean? = null,
    val resync: JobReport? = null,
    val update: JobReport? = null,
    val restart: JobReport? = null,
)

/** Exactly one of [jpeg] (base64) or [error]. */
@Serializable internal data class ScreenshotBody(val jpeg: String? = null, val error: String? = null)

@Serializable internal data class HeartbeatReply(val ok: Boolean = true, val version: String? = null)
