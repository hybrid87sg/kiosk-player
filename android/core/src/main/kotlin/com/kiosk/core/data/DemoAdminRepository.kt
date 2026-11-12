package com.kiosk.core.data

import com.kiosk.core.model.Device
import com.kiosk.core.model.DeviceRef
import com.kiosk.core.model.Library
import com.kiosk.core.model.Media
import com.kiosk.core.model.MediaType
import com.kiosk.core.model.Mounting
import com.kiosk.core.model.isFlipped
import com.kiosk.core.model.serverOrientation
import com.kiosk.core.model.PlayerSetup
import com.kiosk.core.model.PlaylistDetail
import com.kiosk.core.model.PlaylistEntry
import com.kiosk.core.model.PlaylistItem
import com.kiosk.core.model.PlaylistSummary
import com.kiosk.core.model.RemovedMedia
import com.kiosk.core.model.Role
import com.kiosk.core.model.ScreenShape
import com.kiosk.core.model.Session
import com.kiosk.core.model.User
import com.kiosk.core.model.WaitingDevice
import com.kiosk.core.network.ApiException
import com.kiosk.core.player.heavyVideoWarning
import kotlinx.coroutines.delay

/** The demo's first location; its playlists and first screen live here. */
private const val DEMO_LOCATION = "Main lobby"

/**
 * Demo mode: a pretend server kept in memory, filled with sample data, so the
 * app can be tried without a server or Google setup. It behaves like the real
 * server (same rules and error messages) but forgets everything on restart.
 * [now] is the clock, replaceable in tests.
 */
class DemoAdminRepository(
    private val myEmail: String = "you@yourcompany.com",
    private val now: () -> Long = System::currentTimeMillis,
    private val latencyMs: Long = 250,
) : AdminRepository {
    override val isDemo = true

    private data class DemoMedia(val media: Media, val shapeKnownAt: Long)
    private data class DemoPlaylist(
        val id: Long, var name: String, var orientation: ScreenShape, var version: Int, var items: List<PlaylistEntry>,
        val auto: Boolean = false, // one of the location's automatic two
        val location: String = DEMO_LOCATION,
    )

    private var nextId = 100L
    private val start = now()
    private val media = mutableListOf(
        demoFile(1, "Lobby promo.mp4", MediaType.VIDEO, 1_400_000_000, 3840, 2160),
        demoFile(2, "Summer menu.jpg", MediaType.IMAGE, 3_200_000, 3840, 2160),
        // Expires in 2 days, so the expiry date shows up in Demo mode.
        demoFile(3, "Opening hours.png", MediaType.IMAGE, 1_100_000, 1920, 1080).let { it.copy(media = it.media.copy(expiresAt = start + 2 * 86_400_000L)) },
        demoFile(4, "Brand reel 4K.mp4", MediaType.VIDEO, 2_800_000_000, 3840, 2160),
        demoFile(5, "Staff picks.webp", MediaType.IMAGE, 800_000, 1920, 1080),
        demoFile(6, "Menu board portrait.jpg", MediaType.IMAGE, 2_100_000, 2160, 3840),
        demoFile(7, "Welcome vertical.mp4", MediaType.VIDEO, 820_000_000, 2160, 3840),
    )
    private val playlists = mutableListOf(
        DemoPlaylist(1, "Lobby screens", ScreenShape.LANDSCAPE, 1, listOf(PlaylistEntry(1, 10), PlaylistEntry(2, 10), PlaylistEntry(3, 8))),
        DemoPlaylist(2, "Reception portrait", ScreenShape.PORTRAIT, 1, listOf(PlaylistEntry(6, 12), PlaylistEntry(7, 10)), location = "Branch office"),
        // A location's automatic two: a screen with no playlist of its own plays the one that fits it.
        DemoPlaylist(3, "Landscape", ScreenShape.LANDSCAPE, 1, listOf(PlaylistEntry(4, 10), PlaylistEntry(5, 10)), auto = true),
        DemoPlaylist(4, "Portrait", ScreenShape.PORTRAIT, 1, listOf(PlaylistEntry(7, 10)), auto = true),
        DemoPlaylist(5, "Landscape", ScreenShape.LANDSCAPE, 1, emptyList(), auto = true, location = "Branch office"),
        DemoPlaylist(6, "Portrait", ScreenShape.PORTRAIT, 1, listOf(PlaylistEntry(6, 12)), auto = true, location = "Branch office"),
    )
    private val locationIds = mutableMapOf(DEMO_LOCATION to 1L, "Branch office" to 2L)

    /** A location typed when setting up a screen is made on the spot, with its automatic two. */
    private fun ensureLocation(name: String) {
        if (name in locationIds) return
        locationIds[name] = nextId++
        ScreenShape.entries.forEach { shape ->
            playlists += DemoPlaylist(nextId++, shape.label, shape, 1, emptyList(), auto = true, location = name)
        }
    }

    /** What a screen plays: the playlist it is pinned to, or else the automatic one of its shape. */
    private fun playlistOf(d: Device): DemoPlaylist? =
        d.playlistId?.let { pid -> playlists.firstOrNull { it.id == pid } }
            ?: playlists.firstOrNull { it.auto && it.orientation == d.mounting.shape && it.location == d.location }
    private val devices = mutableListOf(
        Device(
            1, "Back wall", "Main lobby", Mounting.LANDSCAPE, 1, online = true, lastSeen = start, currentFilename = "Lobby promo.mp4",
            freeBytes = 21_400_000_000, hoursSummary = "Mon–Fri 08:00–18:00 · Sat–Sun closed",
        ),
        Device(2, "Reception", "Branch office", Mounting.PORTRAIT_RIGHT, 2, online = false, lastSeen = start - 3 * 3_600_000, currentFilename = "Menu board portrait.jpg", freeBytes = 9_800_000_000),
    )
    // A TV that found the server by itself and is waiting to be added.
    private val waiting = mutableListOf(WaitingDevice(99, "Xiaomi MIBOX4", null, "DEMO42", start))
    private val users = mutableListOf(
        User(1, myEmail, Role.SUPERADMIN),
        User(2, "maria@yourcompany.com", Role.SYSTEM_MANAGER),
        User(3, "dan@yourcompany.com", Role.CONTENT_UPLOADER),
    )
    // "Expired and removed": one sample file that expired last week.
    private val removed = mutableListOf(
        RemovedMedia(50, "Spring sale.jpg", MediaType.IMAGE, 2_400_000, ScreenShape.LANDSCAPE, start - 5 * 86_400_000L, "expired"),
    )
    private var driveDropDone = false
    private var lastSync = start - 2 * 60_000

    private fun demoFile(id: Long, name: String, type: MediaType, size: Long, w: Int, h: Int, knownAt: Long = 0) =
        DemoMedia(
            Media(
                id, name, type, if (type == MediaType.VIDEO) "video/mp4" else "image/jpeg", size, "demo$id", w, h,
                shapeOf(w, h), start - id * 1000, heavyVideoWarning(type == MediaType.VIDEO, w, h),
            ),
            knownAt,
        )

    private fun shapeOf(w: Int?, h: Int?): ScreenShape? =
        if (w == null || h == null || w <= 0 || h <= 0) null else if (w >= h) ScreenShape.LANDSCAPE else ScreenShape.PORTRAIT

    /** New files show as "checking shape" for a few seconds, like a real Drive upload. */
    private fun DemoMedia.visible(): Media = if (now() < shapeKnownAt) media.copy(orientation = null) else media

    private fun mediaById(id: Long) = media.firstOrNull { it.media.id == id }?.visible()

    /** Files whose expiry date has passed leave the library and every playlist. */
    private fun expireDue() {
        media.filter { it.media.expiresAt?.let { e -> e <= now() } == true }.forEach { retire(it.media.id, "expired") }
    }

    private fun retire(id: Long, reason: String) {
        val m = media.firstOrNull { it.media.id == id } ?: throw ApiException("Not found", 404)
        media.remove(m)
        removed.add(0, RemovedMedia(m.media.id, m.media.filename, m.media.type, m.media.size, m.media.orientation, now(), reason))
        playlists.filter { pl -> pl.items.any { it.mediaId == id } }.forEach { pl ->
            pl.items = pl.items.filter { it.mediaId != id }
            pl.version++
        }
    }

    private fun checkSchedule(startsAt: Long?, expiresAt: Long?) {
        if (expiresAt != null && expiresAt <= now()) throw ApiException("Choose an end date in the future", 400)
        if (startsAt != null && expiresAt != null && startsAt >= expiresAt) throw ApiException("The end date must be after the start date", 400)
    }

    private suspend fun pause() { if (latencyMs > 0) delay(latencyMs) }

    override suspend fun signIn(username: String, password: String) = Session("demo", myEmail, Role.SUPERADMIN)
    override suspend fun signOut() {}

    override suspend fun library(): Library {
        pause()
        expireDue()
        return Library(media.map { it.visible() }.sortedByDescending { it.createdAt }, lastSync, removed = removed.toList())
    }

    override suspend fun syncLibrary(): Library {
        pause(); pause()
        if (!driveDropDone) {
            driveDropDone = true
            media += demoFile(nextId++, "Weekend promo.mp4", MediaType.VIDEO, 640_000_000, 3840, 2160, knownAt = now() + 3000)
                .let { it.copy(media = it.media.copy(createdAt = now())) }
        }
        lastSync = now()
        return library()
    }

    override suspend fun upload(file: UploadSource, startsAt: Long?, expiresAt: Long?, onProgress: (Float) -> Unit): Media {
        checkSchedule(startsAt, expiresAt)
        val type = when {
            file.mime.startsWith("video/") || file.name.lowercase().endsWith(".mp4") -> MediaType.VIDEO
            file.mime.startsWith("image/") || Regex("\\.(jpe?g|png|webp)$").containsMatchIn(file.name.lowercase()) -> MediaType.IMAGE
            else -> throw ApiException("Only .mp4, .jpg, .png and .webp files are supported", 415)
        }
        for (step in 1..20) { delay(120); onProgress(step / 20f) }
        val item = DemoMedia(
            Media(
                nextId++, file.name, type, file.mime, file.size, "demo-upload", file.width, file.height,
                shapeOf(file.width, file.height) ?: ScreenShape.LANDSCAPE, now(),
                heavyVideoWarning(type == MediaType.VIDEO, file.width, file.height),
                startsAt = startsAt, expiresAt = expiresAt,
            ),
            shapeKnownAt = now() + 3000,
        )
        media += item
        return item.visible()
    }

    override suspend fun setMediaSchedule(id: Long, startsAt: Long?, expiresAt: Long?): Media {
        pause()
        checkSchedule(startsAt, expiresAt)
        val i = media.indexOfFirst { it.media.id == id }.takeIf { it >= 0 } ?: throw ApiException("Not found", 404)
        media[i] = media[i].copy(media = media[i].media.copy(startsAt = startsAt, expiresAt = expiresAt))
        return media[i].visible()
    }

    override suspend fun deleteMedia(id: Long) {
        pause()
        retire(id, "removed")
    }

    override suspend fun restoreMedia(id: Long, startsAt: Long?, expiresAt: Long?): Media {
        pause()
        checkSchedule(startsAt, expiresAt)
        val r = removed.firstOrNull { it.id == id } ?: throw ApiException("Not found", 404)
        removed.remove(r)
        val mime = if (r.type == MediaType.VIDEO) "video/mp4" else "image/jpeg"
        val restored = DemoMedia(
            Media(r.id, r.filename, r.type, mime, r.size, "demo${r.id}", null, null, r.orientation, now(), startsAt = startsAt, expiresAt = expiresAt),
            0,
        )
        media += restored
        return restored.visible()
    }

    private fun DemoPlaylist.summary() = PlaylistSummary(
        id, name, orientation, version, items.size,
        devices.filter { playlistOf(it)?.id == id }.map { DeviceRef(it.id, it.name) },
        locationId = locationIds.getValue(location), location = location, auto = auto,
    )

    private fun DemoPlaylist.detail(): PlaylistDetail {
        val s = summary()
        return PlaylistDetail(
            s.id, s.name, s.orientation, s.version, s.itemCount, s.devices,
            items.mapNotNull { e ->
                mediaById(e.mediaId)?.let { m ->
                    PlaylistItem(
                        m.id, e.imageSeconds, m.filename, m.type, m.mime, m.size, m.md5, m.orientation, e.startAt, e.endAt,
                        startsAt = m.startsAt, expiresAt = m.expiresAt,
                    )
                }
            },
            locationId = s.locationId, location = s.location, auto = s.auto,
        )
    }

    private fun findPlaylist(id: Long) = playlists.firstOrNull { it.id == id } ?: throw ApiException("Not found", 404)

    override suspend fun playlists(): List<PlaylistSummary> {
        pause()
        return playlists.sortedWith(compareBy({ it.location }, { !it.auto }, { it.name })).map { it.summary() }
    }
    override suspend fun playlist(id: Long): PlaylistDetail { pause(); return findPlaylist(id).detail() }

    override suspend fun createPlaylist(name: String, orientation: ScreenShape, locationId: Long): PlaylistDetail {
        pause()
        if (name.isBlank()) throw ApiException("Give the playlist a name", 400)
        val location = locationIds.entries.firstOrNull { it.value == locationId }?.key
            ?: throw ApiException("Choose the location this playlist is for", 400)
        val p = DemoPlaylist(nextId++, name.trim(), orientation, 1, emptyList(), location = location)
        playlists += p
        return p.detail()
    }

    override suspend fun updatePlaylist(id: Long, name: String, orientation: ScreenShape): PlaylistDetail {
        pause()
        if (name.isBlank()) throw ApiException("Give the playlist a name", 400)
        val p = findPlaylist(id)
        if (p.auto && (name.trim() != p.name || orientation != p.orientation)) {
            throw ApiException("This is a location's automatic playlist: its name and shape can't be changed. Change what's in it instead.", 409)
        }
        p.name = name.trim(); p.orientation = orientation; p.version++
        return p.detail()
    }

    override suspend fun savePlaylistItems(id: Long, items: List<PlaylistEntry>): PlaylistDetail {
        pause()
        val p = findPlaylist(id)
        items.firstOrNull { e -> media.none { it.media.id == e.mediaId } }?.let { throw ApiException("Unknown media_id ${it.mediaId}", 400) }
        p.items = items.toList(); p.version++
        return p.detail()
    }

    override suspend fun deletePlaylist(id: Long) {
        pause()
        if (findPlaylist(id).auto) {
            throw ApiException("This is a location's automatic playlist and can't be deleted. Take its files out to leave it empty.", 409)
        }
        val users = devices.filter { it.playlistId == id }
        if (users.isNotEmpty()) {
            throw ApiException("Still playing on ${users.joinToString { it.name.orEmpty() }}. Move those players to another playlist first.", 409)
        }
        playlists.remove(findPlaylist(id))
    }

    private fun Device.withPlaylistName() = copy(playlistName = playlistOf(this)?.name, playlistAuto = playlistId == null)

    override suspend fun devices(): List<Device> {
        pause()
        return devices.sortedWith(compareBy({ it.location ?: "￿" }, { it.name })).map { it.withPlaylistName() }
    }

    override suspend fun waitingDevices(): List<WaitingDevice> {
        pause()
        return waiting.toList()
    }

    override suspend fun claimDevice(code: String, setup: PlayerSetup): Device {
        pause()
        val clean = code.removePrefix("kiosk-pair:").uppercase().filter { it.isLetterOrDigit() }
        if (clean.length != 6) throw ApiException("No player is showing that code", 404)
        if (setup.name.isBlank()) throw ApiException("Give the player a name", 400)
        waiting.removeAll { it.pairingCode == clean }
        val location = setup.location?.trim()?.ifBlank { null } ?: throw ApiException("Choose a location for this screen", 400)
        ensureLocation(location)
        val d = Device(
            nextId++, setup.name.trim(), location, setup.orientation.serverOrientation, setup.playlistId,
            online = true, lastSeen = now(), freeBytes = 28_100_000_000, flipped = setup.orientation.isFlipped,
        )
        devices += d
        return d.withPlaylistName()
    }

    override suspend fun updateDevice(id: Long, setup: PlayerSetup): Device {
        pause()
        if (setup.name.isBlank()) throw ApiException("Give the player a name", 400)
        val i = devices.indexOfFirst { it.id == id }.takeIf { it >= 0 } ?: throw ApiException("Not found", 404)
        val location = setup.location?.trim()?.ifBlank { null } ?: throw ApiException("Choose a location for this screen", 400)
        ensureLocation(location)
        devices[i] = devices[i].copy(
            name = setup.name.trim(), location = location,
            orientation = setup.orientation.serverOrientation, flipped = setup.orientation.isFlipped, playlistId = setup.playlistId,
        )
        return devices[i].withPlaylistName()
    }

    override suspend fun removeDevice(id: Long) {
        pause()
        if (!devices.removeAll { it.id == id }) throw ApiException("Not found", 404)
    }

    override suspend fun users(): List<User> { pause(); return users.sortedBy { it.email } }

    override suspend fun addUser(username: String, role: Role, password: String): User {
        pause()
        val clean = username.trim().lowercase()
        if (!Regex("^[a-z0-9][a-z0-9._@-]{2,39}$").matches(clean)) {
            throw ApiException("A username is 3 to 40 letters or digits (and . _ - @), starting with a letter or digit", 400)
        }
        if (password.length < 8) throw ApiException("Use a password of at least 8 characters", 400)
        if (users.any { it.email == clean }) throw ApiException("That username is taken", 409)
        return User(nextId++, clean, role, now()).also { users += it }
    }

    override suspend fun setPassword(id: Long, password: String): User {
        pause()
        if (password.length < 8) throw ApiException("Use a password of at least 8 characters", 400)
        return users.firstOrNull { it.id == id } ?: throw ApiException("Not found", 404)
    }

    override suspend fun changeRole(id: Long, role: Role): User {
        pause()
        val i = users.indexOfFirst { it.id == id }.takeIf { it >= 0 } ?: throw ApiException("Not found", 404)
        if (users[i].email == myEmail) throw ApiException("You can't change your own role", 400)
        users[i] = users[i].copy(role = role)
        return users[i]
    }

    override suspend fun removeUser(id: Long) {
        pause()
        val u = users.firstOrNull { it.id == id } ?: throw ApiException("Not found", 404)
        if (u.email == myEmail) throw ApiException("You can't remove yourself", 400)
        users.remove(u)
    }
}
