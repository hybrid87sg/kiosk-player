package com.kiosk.player

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.WebView
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.kiosk.core.model.AppUpdate
import com.kiosk.core.model.DeviceCapabilities
import com.kiosk.core.model.DeviceReport
import com.kiosk.core.model.JobReport
import com.kiosk.core.model.MediaType
import com.kiosk.core.model.Mounting
import com.kiosk.core.model.wireName
import com.kiosk.core.model.PlayerPlaylist
import com.kiosk.core.model.PinHash
import com.kiosk.core.model.WebKioskSettings
import com.kiosk.core.model.ScreenShape
import com.kiosk.core.network.ApiException
import com.kiosk.core.network.normaliseBaseUrl
import com.kiosk.core.player.ContentSync
import com.kiosk.core.player.DownloadException
import com.kiosk.core.model.DayHours
import com.kiosk.core.player.FoundServer
import com.kiosk.core.player.OpeningHours
import com.kiosk.core.player.ServerFinder
import com.kiosk.core.player.RemotePlayerRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File
import java.net.Inet4Address
import java.time.Duration
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/** One thing to show: a downloaded file, or (in Demo mode) a coloured slide. */
data class PlayItem(
    val id: Long,
    val name: String,
    val type: MediaType,
    val file: File?,
    val seconds: Int,
    val shape: ScreenShape?,
    val demoColor: Long? = null,
)

/** What the TV shows right now. */
sealed interface PlayerUi {
    data object Loading : PlayerUi
    /** First launch: find the server, type its address, or try Demo. */
    data class Setup(val typeAddress: Boolean = false) : PlayerUi
    /** Searching the network for the Kiosk server; [found] is null while still searching. */
    data class Finding(val found: List<FoundServer>?, val problem: String? = null) : PlayerUi
    data class Pairing(val code: String, val qrPayload: String, val demo: Boolean, val problem: String? = null) : PlayerUi
    data class Waiting(val name: String?, val title: String, val detail: String, val progress: Float? = null) : PlayerUi
    /** [webKiosk]: set when this screen is a Web Kiosk (a touch opens its web page), 0.12.0. */
    data class Playing(
        val items: List<PlayItem>,
        val mounting: Mounting,
        val badge: String? = null,
        val sound: Boolean = true,
        val webKiosk: WebKioskSettings? = null,
    ) : PlayerUi
    /** Outside the location's working hours: a black screen (and standby where allowed). */
    data class Closed(val opens: String?) : PlayerUi
}

/** How long the server must be silent before the TV looks for it at a new address. */
private const val FOLLOW_SERVER_AFTER_MS = 2 * 60_000L

class PlayerViewModel(app: Application) : AndroidViewModel(app) {
    private val settings = PlayerSettings(app)
    private val mediaDir = File(app.filesDir, "media")
    private val _ui = MutableStateFlow<PlayerUi>(PlayerUi.Loading)
    val ui: StateFlow<PlayerUi> = _ui

    /** How every screen of the app is turned (playback has its own, from the playlist). */
    private val _mounting = MutableStateFlow(
        if (settings.mode == PlayerMode.DEMO) settings.demoMounting else settings.cachedPlaylist?.mounting ?: settings.mounting,
    )
    val mounting: StateFlow<Mounting> = _mounting

    /** Turn picture: the next way round, for a TV whose dashboard setting isn't known yet. */
    fun turnPicture() {
        val order = listOf(Mounting.LANDSCAPE, Mounting.PORTRAIT_RIGHT, Mounting.PORTRAIT_LEFT, Mounting.LANDSCAPE_FLIPPED)
        val next = order[(order.indexOf(_mounting.value) + 1) % order.size]
        useMounting(next)
        if (settings.mode == PlayerMode.DEMO) setDemoMounting(next)
    }

    private fun useMounting(mounting: Mounting) {
        if (settings.mounting != mounting) settings.mounting = mounting
        _mounting.value = mounting
    }

    /** Set by the playback screen, reported in the heartbeat ("Now playing"). */
    @Volatile var currentMediaId: Long? = null

    /** Last playback failure, sent until a file plays again. Empty string clears it on the server. */
    @Volatile private var playbackError: String? = null
    private var capabilities: DeviceCapabilities? = null
    private var reportStatus: (suspend () -> Unit)? = null

    /** The screen hit a decoder or file error. Logged by the player; repeated here for the admin app. */
    fun notePlaybackProblem(mediaId: Long?, message: String) {
        if (mediaId != null) currentMediaId = mediaId
        playbackError = message.take(500)
        pushStatus()
    }

    fun notePlaybackHealthy() {
        if (playbackError == null) return
        playbackError = null
        pushStatus()
    }

    private fun pushStatus() {
        val send = reportStatus ?: return
        viewModelScope.launch {
            try {
                send()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The TV keeps playing if the report doesn't get through.
            }
        }
    }

    /** Reset sync in progress (or just finished), reported with each heartbeat. */
    @Volatile private var resyncReport: JobReport? = null
    private var updateJob: Job? = null

    /** What the app says about itself and its Reset sync / app update, in each heartbeat. */
    private fun deviceReport(): DeviceReport {
        val app = getApplication<Application>()
        return DeviceReport(
            androidSdk = Build.VERSION.SDK_INT,
            versionCode = BuildConfig.VERSION_CODE,
            canInstallApps = runCatching { AppUpdater.canInstall(app) }.getOrNull(),
            // For the dashboard's Web Kiosk warnings (0.12.0).
            touchscreen = runCatching { app.packageManager.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN) }.getOrNull(),
            webviewVersion = runCatching { WebView.getCurrentWebViewPackage()?.versionName ?: "" }.getOrDefault(""),
            rotationSensor = runCatching { app.packageManager.hasSystemFeature(PackageManager.FEATURE_SENSOR_ACCELEROMETER) }.getOrNull(),
            resync = resyncReport,
            update = settings.updateReport,
        )
    }

    /** Why the app last closed by itself (see Watchdog), for the dashboard. */
    private fun lastRestart(): Pair<String, Long>? {
        val reason = settings.lastRestartReason ?: return null
        val at = settings.lastRestartAt ?: return null
        return reason to at
    }

    private suspend fun deviceCapabilities(): DeviceCapabilities {
        val known = capabilities ?: withContext(Dispatchers.Default) {
            runCatching { DeviceCapabilitiesReader.read(getApplication()) }.getOrDefault(DeviceCapabilities())
        }.also { capabilities = it }
        val (width, height) = DeviceCapabilitiesReader.displaySize(getApplication())
        return if (width == known.displayWidth && height == known.displayHeight) known
        else known.copy(displayWidth = width, displayHeight = height)
    }

    val isDemo: Boolean get() = settings.mode == PlayerMode.DEMO

    /** The staff PIN set on the dashboard (5 quick taps in the top-left corner ask for it), 0.12.0. */
    val staffPin: PinHash? get() = settings.cachedPlaylist?.browser?.pin

    /**
     * "Automatic: follow this screen" (0.12.1): the activity lets Android turn the screen
     * (rotation sensor or Android's own setting) instead of keeping it landscape.
     */
    private val _followDevice = MutableStateFlow(settings.cachedPlaylist?.followDevice == true)
    val followDevice: StateFlow<Boolean> = _followDevice

    /** Wakes the main loop early (the screen was turned, so its playlist may change). */
    private val wake = Channel<Unit>(Channel.CONFLATED)

    /**
     * Android turned the screen: tell the server its new size straight away, then ask for the
     * playlist again, so a screen that follows itself switches between Landscape and Portrait.
     */
    fun screenTurned() {
        viewModelScope.launch {
            try {
                reportStatus?.invoke()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The next check-in reports it.
            }
            wake.trySend(Unit)
        }
    }

    /** True when this screen is a Web Kiosk. */
    val isWebKiosk: Boolean get() = settings.cachedPlaylist?.webKiosk != null
    val serverUrl: String? get() = settings.serverUrl
    val demoMounting: Mounting get() = settings.demoMounting

    private var job: Job? = null
    private val finder = ServerFinder()

    init { start() }

    private fun start() {
        job?.cancel()
        job = viewModelScope.launch {
            when (settings.mode) {
                null -> _ui.value = PlayerUi.Setup()
                PlayerMode.DEMO -> _ui.value = PlayerUi.Pairing("DEMO42", "kiosk-pair:DEMO42", demo = true)
                PlayerMode.SERVER -> {
                    val url = settings.serverUrl
                    if (url == null) _ui.value = PlayerUi.Setup() else runServer(url)
                }
            }
        }
    }

    // ---------- Choices from the setup and settings screens ----------

    fun chooseDemo() {
        settings.mode = PlayerMode.DEMO
        _mounting.value = settings.demoMounting
        start()
    }

    /** Searches this TV's network for the Kiosk server; connects straight away if there's just one. */
    fun findServer() {
        job?.cancel()
        job = viewModelScope.launch {
            _ui.value = PlayerUi.Finding(found = null)
            val own = ownAddress()
            if (own == null) {
                _ui.value = PlayerUi.Finding(emptyList(), "This TV isn't connected to a network. Connect it to Wi-Fi or a cable first.")
                return@launch
            }
            val found = finder.find(own)
            when (found.size) {
                0 -> _ui.value = PlayerUi.Finding(
                    emptyList(),
                    "No Kiosk server found on this network (${own.substringBeforeLast('.')}.x). " +
                        "Check that the Kiosk add-on is running in Home Assistant, or type its address.",
                )
                1 -> chooseFound(found.single())
                else -> _ui.value = PlayerUi.Finding(found)
            }
        }
    }

    fun chooseFound(server: FoundServer) = connect(server.url, server.serverId)

    fun typeAddress() {
        job?.cancel()
        _ui.value = PlayerUi.Setup(typeAddress = true)
    }

    fun backToSetup() {
        job?.cancel()
        _ui.value = PlayerUi.Setup()
    }

    fun chooseServer(address: String) = connect(normaliseBaseUrl(address), serverId = null)

    private fun connect(url: String, serverId: String?) {
        settings.serverUrl = url
        settings.serverId = serverId
        settings.token = null
        settings.cachedPlaylist = null
        settings.mode = PlayerMode.SERVER
        start()
    }

    /** Forget everything (server, pairing, downloaded files) and go back to setup. */
    fun resetEverything() {
        job?.cancel()
        val mounted = _mounting.value // the screen is still on the wall the same way
        settings.clear()
        settings.mounting = mounted
        mediaDir.deleteRecursively()
        start()
    }

    fun startDemoPlayback() {
        _ui.value = PlayerUi.Playing(demoItems(), settings.demoMounting, badge = "Demo mode")
    }

    fun setDemoMounting(mounting: Mounting) {
        settings.demoMounting = mounting
        _mounting.value = mounting
        _ui.update { if (it is PlayerUi.Playing) it.copy(mounting = mounting) else it }
    }

    // ---------- Real server ----------

    private suspend fun runServer(url: String) {
        val repo = RemotePlayerRepository(url, settings.token)
        val sync = ContentSync(repo.httpClient, repo.baseUrl, mediaDir)
        val caps = deviceCapabilities()
        reportStatus = {
            repo.heartbeat(
                currentMediaId, sync.freeBytes(), BuildConfig.VERSION_NAME,
                decoders = deviceCapabilities(), playbackError = playbackError.orEmpty(), lastRestart = lastRestart(), report = deviceReport(),
            )
        }

        // After a power cut, start playing what's already on the box straight away
        // (or stay dark, if it's outside working hours).
        if (settings.token != null) settings.cachedPlaylist?.let { show(it, sync); applyHours(it.hours) { show(it, sync) } }

        // Remember which server this is, so the TV can find it again if its address changes.
        if (settings.serverId == null) {
            runCatching { repo.config().serverId }.getOrNull()?.let { settings.serverId = it }
        }

        waitUntilPaired(repo, caps)
        // Tell the server what this box can play before the first playlist, so the
        // right copy is chosen straight away.
        try {
            reportStatus?.invoke()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Pairing already succeeded; a missed heartbeat is reported on the next loop.
        }
        var version: String? = settings.cachedPlaylist?.version
        var unreachableSince: Long? = null
        while (true) {
            var wait = 60_000L
            try {
                val playlist = repo.playlist()
                if (playlist.version != version || (playlist.items + playlist.upcoming).any { !sync.isReady(it) }) {
                    download(playlist, sync, repo, caps)
                    settings.cachedPlaylist = playlist
                    version = playlist.version
                }
                show(playlist, sync)
                // Asked for on the dashboard (0.11.0).
                playlist.actions.update?.let { startUpdate(it, repo) }
                playlist.actions.resync?.let { resync(it, playlist, sync) } ?: run { resyncReport = null }
                val latestCaps = deviceCapabilities()
                repo.heartbeat(
                    currentMediaId, sync.freeBytes(), BuildConfig.VERSION_NAME,
                    timeZone = ZoneId.systemDefault().id, afterHours = AfterHours.mode(getApplication()),
                    decoders = latestCaps, playbackError = playbackError.orEmpty(), lastRestart = lastRestart(), report = deviceReport(),
                )
                unreachableSince = null
            } catch (e: ApiException) {
                when (e.status) {
                    401 -> { // removed in Kiosk Admin: forget everything and show a new code
                        repo.token = null
                        settings.token = null
                        settings.cachedPlaylist = null
                        sync.removeUnused(emptyList())
                        version = null
                        _ui.value = PlayerUi.Loading
                        waitUntilPaired(repo, caps)
                        continue
                    }
                    403 -> { waitUntilPaired(repo, caps); continue }
                    else -> {
                        offline(e.message)
                        wait = 15_000
                        // No answer at all for 2 minutes: maybe the server got a new
                        // address from the router. Look for it (at most every 2 minutes).
                        val now = System.currentTimeMillis()
                        val since = unreachableSince ?: now.also { unreachableSince = it }
                        if (e.status == null && now - since > FOLLOW_SERVER_AFTER_MS) {
                            unreachableSince = now
                            if (followServer()) return
                        }
                    }
                }
            } catch (e: DownloadException) {
                val text = if (e.message?.contains("free space") == true) "Not enough free space, retrying…" else "Download problem, retrying…"
                val current = _ui.value
                _ui.value = when (current) {
                    is PlayerUi.Playing -> current.copy(badge = text)
                    // Waiting for its first files: say which file and why, so it can be read off the screen.
                    is PlayerUi.Waiting -> current.copy(detail = e.message?.let { "$text\n$it" } ?: text)
                    else -> current
                }
                wait = 15_000
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Anything unexpected (an odd reply, a storage hiccup): keep playing what's on the
                // box and try again shortly. Letting it escape would close the app to the TV's home screen.
                Log.w("KioskPlayer", "Unexpected problem, retrying", e)
                offline("Something went wrong (${e.javaClass.simpleName}). Retrying…")
                wait = 15_000
            }
            // Working hours (from the last playlist, so they hold even while offline).
            wait = minOf(wait, applyHours(settings.cachedPlaylist?.hours) { settings.cachedPlaylist?.let { show(it, sync) } })
            withTimeoutOrNull(wait) { wake.receive() } // or sooner, when the screen is turned
        }
    }

    /**
     * Reset sync: every file is downloaded again into a fresh folder while the
     * screen keeps playing, then the fresh copy takes over and the old files go.
     * A cut-off download throws to the loop, which tries again (it resumes).
     */
    private suspend fun resync(id: String, playlist: PlayerPlaylist, sync: ContentSync) {
        if (settings.resyncDoneId == id) { // done, but the server hasn't heard yet
            if (resyncReport?.id != id) resyncReport = JobReport(id, "done")
            return
        }
        resyncReport = JobReport(id, "downloading", 0, (playlist.items + playlist.upcoming).distinctBy { it.id to it.md5 }.size)
        pushStatus()
        var lastPush = 0L
        val fresh = sync.freshCopy(
            playlist,
            onProgress = { done, total ->
                resyncReport = JobReport(id, "downloading", done, total)
                if (done < total) setBadge("Refreshing files: ${minOf(done + 1, total)} of $total")
                val now = System.currentTimeMillis()
                if (now - lastPush > 3_000 || done == total) { lastPush = now; pushStatus() }
            },
            onSwitching = {
                resyncReport = JobReport(id, "switching")
                pushStatus()
            },
            onDeletingFirst = {
                if (_ui.value is PlayerUi.Playing) {
                    _ui.value = PlayerUi.Waiting(playlist.name, "Getting content ready", "Downloading every file again…")
                }
            },
        )
        settings.resyncDoneId = id
        resyncReport = JobReport(
            id, "done",
            note = if (fresh) null else "There wasn’t room for two copies, so the old files were deleted first",
        )
        // The files are the same ones (same fingerprints): show() keeps playing without a restart.
        setBadge("")
        show(playlist, sync)
        pushStatus()
    }

    /** App update: download, check, and hand to Android's installer (see AppUpdater). */
    private fun startUpdate(update: AppUpdate, repo: RemotePlayerRepository) {
        if (update.versionCode <= BuildConfig.VERSION_CODE) return // already this one: the heartbeat finishes it
        if (updateJob?.isActive == true) return
        val app = getApplication<Application>()
        val last = settings.updateReport
        // Waiting for someone to press Install, or installing: don't start again for a while.
        if (last?.id == update.id && last.step in setOf("waiting_for_install", "installing") &&
            System.currentTimeMillis() - settings.updateReportAt < 15 * 60_000L
        ) return
        if (last?.id == update.id && last.step == "failed") return // the server stops asking
        updateJob = viewModelScope.launch {
            try {
                if (!AppUpdater.canInstall(app)) {
                    throw UpdateException("On the TV, allow Kiosk Player under Settings → Apps → Special app access → Install unknown apps")
                }
                settings.updateReport = JobReport(update.id, "downloading")
                pushStatus()
                val apk = AppUpdater.download(app, repo.httpClient, repo.baseUrl, update)
                settings.updateReport = JobReport(update.id, "installing")
                pushStatus()
                withContext(Dispatchers.IO) { AppUpdater.install(app, apk, update.id) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                settings.updateReport = JobReport(update.id, "failed", error = (e.message ?: "Update failed").take(300))
                pushStatus()
            }
        }
    }

    /** Registers if needed, then shows the pairing code until an admin claims this TV. */
    private suspend fun waitUntilPaired(repo: RemotePlayerRepository, caps: DeviceCapabilities) {
        var lastCode: PlayerUi.Pairing? = null
        while (true) {
            try {
                if (repo.token == null) {
                    settings.token = repo.register(BuildConfig.VERSION_NAME, deviceModel(), caps).token
                }
                val status = repo.status(_mounting.value.wireName)
                if (status.claimed) return
                lastCode = PlayerUi.Pairing(status.pairingCode.orEmpty(), status.qrPayload.orEmpty(), demo = false)
                _ui.value = lastCode
            } catch (e: ApiException) {
                if (e.status == 401) {
                    repo.token = null
                    settings.token = null
                    continue
                }
                // Keep playing saved content if there is any; otherwise explain.
                if (_ui.value !is PlayerUi.Playing) {
                    _ui.value = lastCode?.copy(problem = e.message)
                        ?: PlayerUi.Waiting(null, "Can't reach the server", "${e.message}\nServer: ${settings.serverUrl}")
                }
                delay(10_000)
                continue
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w("KioskPlayer", "Unexpected problem while waiting to be added, retrying", e)
                delay(10_000)
                continue
            }
            delay(4_000)
        }
    }

    private suspend fun download(playlist: PlayerPlaylist, sync: ContentSync, repo: RemotePlayerRepository, caps: DeviceCapabilities) {
        val stillOnScreen = (_ui.value as? PlayerUi.Playing)?.items?.mapNotNull { it.file }.orEmpty()
        sync.sync(playlist, stillOnScreen) { done, total ->
            // Tell the server how far we are, so Kiosk Admin can show "Downloading 2 of 3".
            if (done < total) {
                viewModelScope.launch {
                    try {
                        repo.heartbeat(
                            currentMediaId, sync.freeBytes(), BuildConfig.VERSION_NAME, done to total,
                            decoders = caps, playbackError = playbackError.orEmpty(), lastRestart = lastRestart(), report = deviceReport(),
                        )
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // Progress report is optional.
                    }
                }
            }
            val text = "Downloading ${minOf(done + 1, total)} of $total new files"
            val current = _ui.value
            if (current is PlayerUi.Playing) {
                if (done < total) _ui.value = current.copy(badge = text)
            } else if (current !is PlayerUi.Closed && total > 0) { // downloading at night stays dark
                _ui.value = PlayerUi.Waiting(playlist.name, "Getting content ready", "$text…", done.toFloat() / total)
            }
        }
    }

    // The opening time the device was last put to sleep until, so it's done once per closing.
    private var sleptUntil: Long? = null

    /**
     * Outside working hours: a black screen, and standby where allowed, with
     * an alarm to wake up at opening time. [reopen] shows the playlist again
     * at opening time. Returns how long until the next opening or closing, so
     * the loop checks again right then.
     */
    private fun applyHours(hours: Map<String, DayHours?>?, reopen: () -> Unit): Long {
        val now = ZonedDateTime.now()
        val next = OpeningHours.nextChange(hours, now)
        if (OpeningHours.isOpen(hours, now)) {
            sleptUntil = null
            if (_ui.value is PlayerUi.Closed) reopen()
        } else {
            _ui.value = PlayerUi.Closed(next?.format(DateTimeFormatter.ofPattern("EEE HH:mm")))
            val opensAt = next?.toInstant()?.toEpochMilli()
            if (sleptUntil != opensAt || opensAt == null) {
                sleptUntil = opensAt
                AfterHours.sleepUntil(getApplication(), opensAt)
            }
        }
        return next?.let { (Duration.between(now, it).toMillis() + 1_000).coerceAtLeast(1_000) } ?: Long.MAX_VALUE
    }

    /** Shows the playlist's downloaded files, or "Waiting for content". */
    private fun show(playlist: PlayerPlaylist, sync: ContentSync) {
        // Stay dark after hours (the loop refreshes every minute, also at night).
        if (_ui.value is PlayerUi.Closed && !OpeningHours.isOpen(playlist.hours, ZonedDateTime.now())) return
        _followDevice.value = playlist.followDevice
        useMounting(playlist.mounting)
        val items = playlist.items.filter { sync.isReady(it) }.map {
            PlayItem(it.id, it.filename, it.type, sync.fileFor(it), it.durationSeconds ?: 10, it.orientation)
        }
        _ui.value = if (items.isEmpty()) {
            PlayerUi.Waiting(playlist.name, "Waiting for content", "Add files to this screen's playlist in Kiosk Admin.")
        } else {
            val current = _ui.value
            // Same content: keep playing without restarting, just clear the badge.
            if (current is PlayerUi.Playing && current.items == items && current.mounting == playlist.mounting) {
                current.copy(badge = null, sound = playlist.sound, webKiosk = playlist.webKiosk)
            } else PlayerUi.Playing(items, playlist.mounting, sound = playlist.sound, webKiosk = playlist.webKiosk)
        }
    }

    /**
     * Looks for this TV's server (same ID) at a new address. If it's found,
     * switches to it and starts again (returns true); the TV keeps playing meanwhile.
     */
    private suspend fun followServer(): Boolean {
        val id = settings.serverId ?: return false
        val own = ownAddress() ?: return false
        val moved = finder.find(own, serverId = id).firstOrNull() ?: return false
        if (moved.url == settings.serverUrl) return false
        settings.serverUrl = moved.url
        start()
        return true
    }

    /** This TV's IPv4 address on its network, e.g. "192.168.1.37". */
    private fun ownAddress(): String? {
        val connectivity = getApplication<Application>().getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val link = connectivity.getLinkProperties(connectivity.activeNetwork) ?: return null
        return link.linkAddresses.map { it.address }
            .firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
            ?.hostAddress
    }

    /** e.g. "Xiaomi MIBOX4", on the pairing screen. */
    val deviceModelName: String get() = deviceModel()

    /** e.g. "Xiaomi MIBOX4", shown in Kiosk Signage while this TV waits to be added. */
    private fun deviceModel(): String {
        val maker = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
        return if (Build.MODEL.startsWith(Build.MANUFACTURER, ignoreCase = true)) Build.MODEL else "$maker ${Build.MODEL}"
    }

    private fun offline(message: String?) {
        val current = _ui.value
        if (current is PlayerUi.Playing) _ui.value = current.copy(badge = "Offline · playing saved files")
        else if (current !is PlayerUi.Pairing && current !is PlayerUi.Closed) _ui.value = PlayerUi.Waiting(null, "Can't reach the server", message.orEmpty())
    }

    private fun setBadge(text: String) = _ui.update { if (it is PlayerUi.Playing) it.copy(badge = text.ifEmpty { null }) else it }

    // ---------- Demo mode ----------

    private fun demoItems() = listOf(
        PlayItem(1, "Lobby promo", MediaType.VIDEO, null, 8, ScreenShape.LANDSCAPE, 0xFF1D4ED8),
        PlayItem(2, "Summer menu", MediaType.IMAGE, null, 6, ScreenShape.LANDSCAPE, 0xFFC2410C),
        PlayItem(3, "Menu board portrait", MediaType.IMAGE, null, 6, ScreenShape.PORTRAIT, 0xFFBE123C),
        PlayItem(4, "Welcome vertical", MediaType.VIDEO, null, 6, ScreenShape.PORTRAIT, 0xFF0E7490),
    )
}
