package com.kiosk.admin.ui.players

import com.kiosk.admin.ui.common.KioskViewModel
import com.kiosk.core.data.AdminRepository
import com.kiosk.core.model.Device
import com.kiosk.core.model.PlayerSetup
import com.kiosk.core.model.PlaylistSummary
import com.kiosk.core.model.WaitingDevice
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

data class PlayersUiState(
    val devices: List<Device>? = null,
    /** TVs showing a pairing code right now, waiting to be added. */
    val waiting: List<WaitingDevice> = emptyList(),
    val playlists: List<PlaylistSummary> = emptyList(),
    val busy: Boolean = false,
)

class PlayersViewModel(private val repo: AdminRepository, onSignedOut: () -> Unit) : KioskViewModel(onSignedOut) {
    private val _state = MutableStateFlow(PlayersUiState())
    val state: StateFlow<PlayersUiState> = _state

    init {
        launchSafely { _state.update { it.copy(playlists = repo.playlists()) } }
        // Keep online/offline, "now playing" and new TVs fresh while this screen is open.
        launchSafely {
            while (true) {
                val devices = repo.devices()
                val waiting = repo.waitingDevices()
                _state.update { it.copy(devices = devices, waiting = waiting) }
                delay(10_000)
            }
        }
    }

    private suspend fun reload() {
        _state.update { it.copy(devices = repo.devices(), waiting = repo.waitingDevices(), playlists = repo.playlists()) }
    }

    /** Pairs the TV showing [code] and sets it up. [onDone] closes the form. */
    fun claim(code: String, setup: PlayerSetup, onDone: () -> Unit) = busy {
        val device = repo.claimDevice(code, setup)
        reload()
        onDone()
        say("${device.name} added. It starts playing once its files are downloaded.")
    }

    fun update(id: Long, setup: PlayerSetup, onDone: () -> Unit) = busy {
        repo.updateDevice(id, setup)
        reload()
        onDone()
        say("${setup.name} updated")
    }

    fun remove(device: Device) = busy {
        repo.removeDevice(device.id)
        reload()
        say("${device.name} removed. It now shows a new pairing code.")
    }

    private fun busy(block: suspend () -> Unit) {
        _state.update { it.copy(busy = true) }
        launchSafely(onError = { _state.update { s -> s.copy(busy = false) } }) {
            block()
            _state.update { it.copy(busy = false) }
        }
    }
}
