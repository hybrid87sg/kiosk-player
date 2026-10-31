// The server's web addresses, written as Kotlin functions. Retrofit turns each
// function into an HTTP request, e.g. getPlaylists() becomes GET /api/playlists.
package com.kiosk.core.network

import com.kiosk.core.model.Device
import com.kiosk.core.model.Library
import com.kiosk.core.model.Media
import com.kiosk.core.model.Mounting
import com.kiosk.core.model.PlayerPlaylist
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
    @POST("api/auth/google") suspend fun signIn(@Body body: GoogleSignInBody): Session
    @POST("api/auth/logout") suspend fun signOut(): OkReply

    @GET("api/media") suspend fun library(): Library
    @POST("api/media/sync") suspend fun syncLibrary(): Library
    @POST("api/media") suspend fun upload(
        @Header("X-Filename") encodedName: String,
        @Header("X-Expires-At") expiresAt: String?, // left out when null
        @Body file: RequestBody,
    ): Media
    @PATCH("api/media/{id}") suspend fun setExpiry(@Path("id") id: Long, @Body body: ExpiryBody): Media
    @DELETE("api/media/{id}") suspend fun deleteMedia(@Path("id") id: Long): OkReply
    @POST("api/media/{id}/restore") suspend fun restoreMedia(@Path("id") id: Long, @Body body: ExpiryBody): Media

    @GET("api/playlists") suspend fun playlists(): List<PlaylistSummary>
    @GET("api/playlists/{id}") suspend fun playlist(@Path("id") id: Long): PlaylistDetail
    @POST("api/playlists") suspend fun createPlaylist(@Body body: PlaylistBody): PlaylistDetail
    @PATCH("api/playlists/{id}") suspend fun updatePlaylist(@Path("id") id: Long, @Body body: PlaylistBody): PlaylistDetail
    @PUT("api/playlists/{id}/items") suspend fun saveItems(@Path("id") id: Long, @Body body: ItemsBody): PlaylistDetail
    @DELETE("api/playlists/{id}") suspend fun deletePlaylist(@Path("id") id: Long): OkReply

    @GET("api/devices") suspend fun devices(): List<Device>
    @GET("api/devices/waiting") suspend fun waitingDevices(): List<WaitingDevice>
    @POST("api/devices/claim") suspend fun claim(@Body body: DeviceBody): Device
    @PATCH("api/devices/{id}") suspend fun updateDevice(@Path("id") id: Long, @Body body: DeviceBody): Device
    @DELETE("api/devices/{id}") suspend fun deleteDevice(@Path("id") id: Long): OkReply

    @GET("api/users") suspend fun users(): List<User>
    @POST("api/users") suspend fun addUser(@Body body: UserBody): User
    @PATCH("api/users/{id}") suspend fun changeRole(@Path("id") id: Long, @Body body: RoleBody): User
    @DELETE("api/users/{id}") suspend fun deleteUser(@Path("id") id: Long): OkReply
}

internal interface PlayerApi {
    @GET("api/config") suspend fun config(): ServerConfig
    @POST("api/player/register") suspend fun register(@Body body: AppVersionBody): Registration
    @GET("api/player/status") suspend fun status(): PlayerStatus
    @GET("api/player/playlist") suspend fun playlist(): PlayerPlaylist
    @POST("api/player/heartbeat") suspend fun heartbeat(@Body body: HeartbeatBody): HeartbeatReply
}

// ---------- Request and reply bodies ----------

@Serializable internal data class OkReply(val ok: Boolean = true)
/** null (left out) means "no expiry". */
@Serializable internal data class ExpiryBody(@SerialName("expires_at") val expiresAt: Long? = null)
@Serializable internal data class GoogleSignInBody(@SerialName("id_token") val idToken: String)
@Serializable internal data class PlaylistBody(val name: String, val orientation: ScreenShape)
@Serializable
internal data class ItemBody(
    @SerialName("media_id") val mediaId: Long,
    @SerialName("image_seconds") val imageSeconds: Int,
    @SerialName("start_at") val startAt: Long? = null,
    @SerialName("end_at") val endAt: Long? = null,
)
@Serializable internal data class ItemsBody(val items: List<ItemBody>)
@Serializable internal data class UserBody(val email: String, val role: Role)
@Serializable internal data class RoleBody(val role: Role)
@Serializable
internal data class AppVersionBody(
    @SerialName("app_version") val appVersion: String,
    /** The TV box's make and model, shown while it waits to be added. */
    val model: String? = null,
)

@Serializable
internal data class DeviceBody(
    val code: String? = null,
    val name: String,
    val location: String?,
    val orientation: Mounting,
    @SerialName("playlist_id") val playlistId: Long?,
)

@Serializable
internal data class HeartbeatBody(
    @SerialName("current_media_id") val currentMediaId: Long?,
    @SerialName("free_bytes") val freeBytes: Long?,
    @SerialName("app_version") val appVersion: String,
    /** While new files download: how many are done, out of how many. */
    @SerialName("download_done") val downloadDone: Int? = null,
    @SerialName("download_total") val downloadTotal: Int? = null,
)

@Serializable internal data class HeartbeatReply(val ok: Boolean = true, val version: String? = null)
