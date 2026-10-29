package com.kiosk.player

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.kiosk.core.model.MediaType
import com.kiosk.core.model.Mounting
import com.kiosk.core.model.PlayerPlaylist
import com.kiosk.core.model.ScreenShape
import com.kiosk.core.network.ApiException
import com.kiosk.core.network.normaliseBaseUrl
import com.kiosk.core.player.ContentSync
import com.kiosk.core.player.DownloadException
import com.kiosk.core.player.RemotePlayerRepository
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File

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
    /** First launch: choose Demo or a server. */
    data object Setup : PlayerUi
    data class Pairing(val code: String, val qrPayload: String, val demo: Boolean, val problem: String? = null) : PlayerUi
    data class Waiting(val name: String?, val title: String, val detail: String, val progress: Float? = null) : PlayerUi
    data class Playing(val items: List<PlayItem>, val mounting: Mounting, val badge: String? = null) : PlayerUi
}

class PlayerViewModel(app: Application) : AndroidViewModel(app) {
    private val settings = PlayerSettings(app)
    private val mediaDir = File(app.filesDir, "media")
    private val _ui = MutableStateFlow<PlayerUi>(PlayerUi.Loading)
    val ui: StateFlow<PlayerUi> = _ui

    /** Set by the playback screen, reported in the heartbeat ("Now playing"). */
    @Volatile var currentMediaId: Long? = null

    val isDemo: Boolean get() = settings.mode == PlayerMode.DEMO
    val serverUrl: String? get() = settings.serverUrl
    val demoMounting: Mounting get() = settings.demoMounting

    private var job: Job? = null

    init { start() }

    private fun start() {
        job?.cancel()
        job = viewModelScope.launch {
            when (settings.mode) {
                null -> _ui.value = PlayerUi.Setup
                PlayerMode.DEMO -> _ui.value = PlayerUi.Pairing("DEMO42", "kiosk-pair:DEMO42", demo = true)
                PlayerMode.SERVER -> {
                    val url = settings.serverUrl
                    if (url == null) _ui.value = PlayerUi.Setup else runServer(url)
                }
            }
        }
    }

    // ---------- Choices from the setup and settings screens ----------

    fun chooseDemo() {
        settings.mode = PlayerMode.DEMO
        start()
    }

    fun chooseServer(address: String) {
        settings.serverUrl = normaliseBaseUrl(address)
        settings.token = null
        settings.cachedPlaylist = null
        settings.mode = PlayerMode.SERVER
        start()
    }

    /** Forget everything (server, pairing, downloaded files) and go back to setup. */
    fun resetEverything() {
        job?.cancel()
        settings.clear()
        mediaDir.deleteRecursively()
        start()
    }

    fun startDemoPlayback() {
        _ui.value = PlayerUi.Playing(demoItems(), settings.demoMounting, badge = "Demo mode")
    }

    fun setDemoMounting(mounting: Mounting) {
        settings.demoMounting = mounting
        _ui.update { if (it is PlayerUi.Playing) it.copy(mounting = mounting) else it }
    }

    // ---------- Real server ----------

    private suspend fun runServer(url: String) {
        val repo = RemotePlayerRepository(url, settings.token)
        val sync = ContentSync(repo.httpClient, repo.baseUrl, mediaDir)

        // After a power cut, start playing what's already on the box straight away.
        if (settings.token != null) settings.cachedPlaylist?.let { show(it, sync) }

        waitUntilPaired(repo)
        var version: String? = settings.cachedPlaylist?.version
        while (true) {
            var wait = 60_000L
            try {
                val playlist = repo.playlist()
                if (playlist.version != version || playlist.items.any { !sync.isReady(it) }) {
                    download(playlist, sync, repo)
                    settings.cachedPlaylist = playlist
                    version = playlist.version
                }
                show(playlist, sync)
                repo.heartbeat(currentMediaId, sync.freeBytes(), BuildConfig.VERSION_NAME)
            } catch (e: ApiException) {
                when (e.status) {
                    401 -> { // removed in Kiosk Admin: forget everything and show a new code
                        repo.token = null
                        settings.token = null
                        settings.cachedPlaylist = null
                        sync.removeUnused(emptyList())
                        version = null
                        _ui.value = PlayerUi.Loading
                        waitUntilPaired(repo)
                        continue
                    }
                    403 -> { waitUntilPaired(repo); continue }
                    else -> {
                        offline(e.message)
                        wait = 15_000
                    }
                }
            } catch (e: DownloadException) {
                setBadge("Download problem, retrying…")
                wait = 15_000
            }
            delay(wait)
        }
    }

    /** Registers if needed, then shows the pairing code until an admin claims this TV. */
    private suspend fun waitUntilPaired(repo: RemotePlayerRepository) {
        var lastCode: PlayerUi.Pairing? = null
        while (true) {
            try {
                if (repo.token == null) {
                    settings.token = repo.register(BuildConfig.VERSION_NAME).token
                }
                val status = repo.status()
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
            }
            delay(4_000)
        }
    }

    private suspend fun download(playlist: PlayerPlaylist, sync: ContentSync, repo: RemotePlayerRepository) {
        sync.sync(playlist) { done, total ->
            // Tell the server how far we are, so Kiosk Admin can show "Downloading 2 of 3".
            if (done < total) {
                viewModelScope.launch {
                    runCatching { repo.heartbeat(currentMediaId, sync.freeBytes(), BuildConfig.VERSION_NAME, done to total) }
                }
            }
            val text = "Downloading ${minOf(done + 1, total)} of $total new files"
            val current = _ui.value
            if (current is PlayerUi.Playing) {
                if (done < total) _ui.value = current.copy(badge = text)
            } else if (total > 0) {
                _ui.value = PlayerUi.Waiting(playlist.name, "Getting content ready", "$text…", done.toFloat() / total)
            }
        }
    }

    /** Shows the playlist's downloaded files, or "Waiting for content". */
    private fun show(playlist: PlayerPlaylist, sync: ContentSync) {
        val items = playlist.items.filter { sync.isReady(it) }.map {
            PlayItem(it.id, it.filename, it.type, sync.fileFor(it), it.durationSeconds ?: 10, it.orientation)
        }
        _ui.value = if (items.isEmpty()) {
            PlayerUi.Waiting(playlist.name, "Waiting for content", "Add files to this screen's playlist in Kiosk Admin.")
        } else {
            val current = _ui.value
            // Same content: keep playing without restarting, just clear the badge.
            if (current is PlayerUi.Playing && current.items == items && current.mounting == playlist.orientation) current.copy(badge = null)
            else PlayerUi.Playing(items, playlist.orientation)
        }
    }

    private fun offline(message: String?) {
        val current = _ui.value
        if (current is PlayerUi.Playing) _ui.value = current.copy(badge = "Offline · playing saved files")
        else if (current !is PlayerUi.Pairing) _ui.value = PlayerUi.Waiting(null, "Can't reach the server", message.orEmpty())
    }

    private fun setBadge(text: String) = _ui.update { if (it is PlayerUi.Playing) it.copy(badge = text) else it }

    // ---------- Demo mode ----------

    private fun demoItems() = listOf(
        PlayItem(1, "Lobby promo", MediaType.VIDEO, null, 8, ScreenShape.LANDSCAPE, 0xFF1D4ED8),
        PlayItem(2, "Summer menu", MediaType.IMAGE, null, 6, ScreenShape.LANDSCAPE, 0xFFC2410C),
        PlayItem(3, "Menu board portrait", MediaType.IMAGE, null, 6, ScreenShape.PORTRAIT, 0xFFBE123C),
        PlayItem(4, "Welcome vertical", MediaType.VIDEO, null, 6, ScreenShape.PORTRAIT, 0xFF0E7490),
    )
}
