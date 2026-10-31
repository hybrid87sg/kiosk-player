package com.kiosk.admin.ui.library

import com.kiosk.admin.ui.common.KioskViewModel
import com.kiosk.core.data.AdminRepository
import com.kiosk.core.data.UploadSource
import com.kiosk.core.model.Library
import com.kiosk.core.model.Media
import com.kiosk.core.model.RemovedMedia
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

data class Upload(val name: String, val progress: Float)

data class LibraryUiState(
    val library: Library? = null,
    val refreshing: Boolean = false,
    val upload: Upload? = null,
)

class LibraryViewModel(private val repo: AdminRepository, onSignedOut: () -> Unit) : KioskViewModel(onSignedOut) {
    private val _state = MutableStateFlow(LibraryUiState())
    val state: StateFlow<LibraryUiState> = _state

    init {
        load()
        // While a file's shape is still being checked, look again every few seconds.
        launchSafely {
            while (true) {
                delay(3_000)
                if (_state.value.library?.items?.any { it.orientation == null } == true) {
                    _state.update { it.copy(library = repo.library()) }
                }
            }
        }
    }

    fun load() = launchSafely { _state.update { it.copy(library = repo.library()) } }

    /** "Pull to refresh": ask the server to re-read the Drive folder now. */
    fun syncNow() {
        _state.update { it.copy(refreshing = true) }
        launchSafely(onError = { _state.update { s -> s.copy(refreshing = false) } }) {
            val before = _state.value.library?.items?.map { it.id }?.toSet().orEmpty()
            val library = repo.syncLibrary()
            _state.update { it.copy(library = library, refreshing = false) }
            val added = library.items.count { it.id !in before }
            say(if (added > 0) "$added new file${if (added == 1) "" else "s"} found in Google Drive" else "Library is up to date")
        }
    }

    /** [expiresAt]: when it should leave Kiosk, or null for never. */
    fun upload(file: UploadSource, expiresAt: Long?) {
        if (_state.value.upload != null) return say("Wait for the current upload to finish")
        _state.update { it.copy(upload = Upload(file.name, 0f)) }
        launchSafely(onError = { _state.update { s -> s.copy(upload = null) } }) {
            repo.upload(file, expiresAt) { p -> _state.update { it.copy(upload = it.upload?.copy(progress = p)) } }
            _state.update { it.copy(upload = null, library = repo.library()) }
            say("${file.name} saved to Google Drive")
        }
    }

    fun setExpiry(m: Media, expiresAt: Long?) = launchSafely {
        repo.setMediaExpiry(m.id, expiresAt)
        _state.update { it.copy(library = repo.library()) }
        say(if (expiresAt == null) "${m.filename} no longer expires" else "${m.filename}: ${showsUntil(expiresAt).lowercase()}")
    }

    /** "Remove from Kiosk". Google Drive keeps the file. */
    fun remove(m: Media) = launchSafely {
        repo.deleteMedia(m.id)
        _state.update { it.copy(library = repo.library()) }
        say("${m.filename} removed from Kiosk. Google Drive still has it.")
    }

    fun restore(r: RemovedMedia, expiresAt: Long?) = launchSafely {
        repo.restoreMedia(r.id, expiresAt)
        _state.update { it.copy(library = repo.library()) }
        say("${r.filename} is back in the library. Add it to a playlist to show it.")
    }
}
