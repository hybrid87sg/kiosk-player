package com.kiosk.admin.ui.playlists

import com.kiosk.admin.ui.common.KioskViewModel
import com.kiosk.core.data.AdminRepository
import com.kiosk.core.model.Library
import com.kiosk.core.model.MediaType
import com.kiosk.core.model.PlaylistDetail
import com.kiosk.core.model.PlaylistEntry
import com.kiosk.core.model.PlaylistSummary
import com.kiosk.core.model.ScreenShape
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/** The list of playlists. */
class PlaylistsViewModel(private val repo: AdminRepository, onSignedOut: () -> Unit) : KioskViewModel(onSignedOut) {
    private val _playlists = MutableStateFlow<List<PlaylistSummary>?>(null)
    val playlists: StateFlow<List<PlaylistSummary>?> = _playlists

    init { load() }

    fun load() = launchSafely { _playlists.value = repo.playlists() }

    /** Makes an extra playlist for [site] (null = the server's own site). */
    fun create(name: String, shape: ScreenShape, site: String?, onCreated: (Long) -> Unit) = launchSafely {
        val created = repo.createPlaylist(name, shape, site)
        say("${created.name} created. Add files, then save.")
        onCreated(created.id)
    }
}

/** One row being edited. [key] stays the same while the row moves around. */
data class EditItem(
    val key: Long,
    val mediaId: Long,
    val filename: String,
    val type: MediaType,
    val orientation: ScreenShape?,
    val seconds: Int,
    val startAt: Long?,
    val endAt: Long?,
)

data class PlaylistDetailUiState(
    val saved: PlaylistDetail? = null,
    val items: List<EditItem> = emptyList(),
    val library: Library? = null,
    val saving: Boolean = false,
    val deleteProblem: String? = null,
) {
    val dirty: Boolean
        get() = saved != null && saved.items.map { listOf(it.mediaId, it.imageSeconds, it.startAt, it.endAt) } !=
            items.map { listOf(it.mediaId, it.seconds, it.startAt, it.endAt) }
}

/** One playlist: reorder, change picture times, add/remove, then save. */
class PlaylistDetailViewModel(
    private val repo: AdminRepository,
    private val id: Long,
    onSignedOut: () -> Unit,
) : KioskViewModel(onSignedOut) {
    private val _state = MutableStateFlow(PlaylistDetailUiState())
    val state: StateFlow<PlaylistDetailUiState> = _state
    private var nextKey = 1L

    init {
        launchSafely { show(repo.playlist(id)) }
        launchSafely { _state.update { it.copy(library = repo.library()) } }
    }

    private fun show(detail: PlaylistDetail) {
        _state.update {
            it.copy(
                saved = detail,
                items = detail.items.map { i ->
                    EditItem(nextKey++, i.mediaId, i.filename, i.type, i.orientation, i.imageSeconds, i.startAt, i.endAt)
                },
            )
        }
    }

    fun move(from: Int, to: Int) = _state.update {
        if (from !in it.items.indices || to !in it.items.indices || from == to) return@update it
        val list = it.items.toMutableList()
        list.add(to, list.removeAt(from))
        it.copy(items = list)
    }

    fun setSeconds(index: Int, seconds: Int) = _state.update {
        it.copy(items = it.items.mapIndexed { i, item -> if (i == index) item.copy(seconds = seconds.coerceIn(1, 120)) else item })
    }

    fun remove(index: Int) = _state.update { it.copy(items = it.items.filterIndexed { i, _ -> i != index }) }

    fun add(mediaId: Long) = _state.update { s ->
        val m = s.library?.items?.firstOrNull { it.id == mediaId } ?: return@update s
        s.copy(items = s.items + EditItem(nextKey++, m.id, m.filename, m.type, m.orientation, 10, null, null))
    }

    fun undo() { _state.value.saved?.let(::show) }

    fun save() {
        _state.update { it.copy(saving = true) }
        launchSafely(onError = { _state.update { s -> s.copy(saving = false) } }) {
            val detail = repo.savePlaylistItems(id, _state.value.items.map { PlaylistEntry(it.mediaId, it.seconds, it.startAt, it.endAt) })
            show(detail)
            _state.update { it.copy(saving = false) }
            val n = detail.devices.size
            say(if (n == 0) "Saved. No players use this playlist yet." else "Saved. $n screen${if (n == 1) "" else "s"} update within a minute.")
        }
    }

    fun updateSettings(name: String, shape: ScreenShape) = launchSafely {
        val detail = repo.updatePlaylist(id, name, shape)
        _state.update { it.copy(saved = it.saved?.copy(name = detail.name, orientation = detail.orientation, devices = detail.devices)) }
        say("Playlist updated")
    }

    fun delete(onDeleted: () -> Unit) {
        _state.update { it.copy(deleteProblem = null) }
        launchSafely(onError = { e -> _state.update { it.copy(deleteProblem = e.message) } }) {
            repo.deletePlaylist(id)
            say("Playlist deleted")
            onDeleted()
        }
    }

    fun clearDeleteProblem() = _state.update { it.copy(deleteProblem = null) }
}
