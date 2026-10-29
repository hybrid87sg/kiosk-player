package com.kiosk.admin

import android.app.Application
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.kiosk.core.data.AdminRepository
import com.kiosk.core.data.DemoAdminRepository
import com.kiosk.core.data.RemoteAdminRepository
import com.kiosk.core.model.Role

/** Who is signed in, and where their data comes from (real server or Demo mode). */
data class AdminSession(
    val id: Long,
    val repo: AdminRepository,
    val email: String,
    val role: Role,
) {
    val isDemo: Boolean get() = repo.isDemo
}

/**
 * Starts once when the app opens. Holds the current session and remembers the
 * server address and sign-in between app launches (in SharedPreferences, a
 * small key/value store on the phone).
 */
class KioskAdminApplication : Application() {
    private val prefs by lazy { getSharedPreferences("kiosk-admin", Context.MODE_PRIVATE) }
    private var nextSessionId = 1L

    var session by mutableStateOf<AdminSession?>(null)
        private set

    val savedServerUrl: String get() = prefs.getString(KEY_URL, "") ?: ""

    override fun onCreate() {
        super.onCreate()
        // Reopen the last real-server sign-in, if there was one.
        val url = prefs.getString(KEY_URL, null)
        val token = prefs.getString(KEY_TOKEN, null)
        val email = prefs.getString(KEY_EMAIL, null)
        val role = prefs.getString(KEY_ROLE, null)?.let { r -> Role.entries.firstOrNull { it.name == r } }
        if (url != null && token != null && email != null && role != null) {
            session = AdminSession(nextSessionId++, remoteRepository(url, token), email, role)
        }
    }

    fun remoteRepository(url: String, token: String? = null): RemoteAdminRepository =
        RemoteAdminRepository(url, token) { newToken -> prefs.edit().putString(KEY_TOKEN, newToken).apply() }

    fun startRealSession(url: String, repo: RemoteAdminRepository, email: String, role: Role) {
        prefs.edit().putString(KEY_URL, url).putString(KEY_EMAIL, email).putString(KEY_ROLE, role.name).apply()
        session = AdminSession(nextSessionId++, repo, email, role)
    }

    fun startDemo(role: Role) {
        session = AdminSession(nextSessionId++, DemoAdminRepository(), "you@yourcompany.com", role)
    }

    /** Demo mode only: look at the app as a different role. */
    fun switchDemoRole(role: Role) {
        session = session?.takeIf { it.isDemo }?.copy(role = role)
    }

    suspend fun signOut() {
        session?.repo?.signOut()
        prefs.edit().remove(KEY_TOKEN).remove(KEY_EMAIL).remove(KEY_ROLE).apply()
        session = null
    }

    private companion object {
        const val KEY_URL = "server_url"
        const val KEY_TOKEN = "token"
        const val KEY_EMAIL = "email"
        const val KEY_ROLE = "role"
    }
}
