package com.kiosk.admin.ui.common

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kiosk.core.network.ApiException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Shared behaviour for the screens' ViewModels. A ViewModel keeps a screen's
 * data while the phone rotates, and runs server calls in the background.
 *
 * [onSignedOut] is called if the server says our sign-in is no longer valid
 * (for example a superadmin removed us), so the app goes back to sign-in.
 */
abstract class KioskViewModel(private val onSignedOut: () -> Unit) : ViewModel() {
    private val _message = MutableStateFlow<String?>(null)
    /** A short message to show once at the bottom of the screen. */
    val message: StateFlow<String?> = _message

    fun messageShown() { _message.value = null }
    protected fun say(text: String) { _message.value = text }

    /** Runs [block] in the background and turns server errors into messages. */
    protected fun launchSafely(onError: (ApiException) -> Unit = {}, block: suspend () -> Unit): Job =
        viewModelScope.launch {
            try {
                block()
            } catch (e: ApiException) {
                if (e.status == 401) onSignedOut() else {
                    say(e.message ?: "Something went wrong")
                    onError(e)
                }
            }
        }
}
