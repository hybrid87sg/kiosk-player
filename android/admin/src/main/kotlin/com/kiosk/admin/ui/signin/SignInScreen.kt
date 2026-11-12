package com.kiosk.admin.ui.signin

import androidx.compose.runtime.remember
import com.kiosk.admin.ui.common.PasswordField
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Tv
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.kiosk.admin.KioskAdminApplication
import com.kiosk.admin.ui.common.KioskCard
import com.kiosk.admin.ui.common.LocalSnackbar
import com.kiosk.admin.ui.theme.KioskShapes
import com.kiosk.core.model.Role
import com.kiosk.core.network.ApiException
import com.kiosk.core.network.normaliseBaseUrl
import kotlinx.coroutines.launch

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SignInScreen(app: KioskAdminApplication) {
    val scope = rememberCoroutineScope()
    var serverUrl by rememberSaveable { mutableStateOf(app.savedServerUrl) }
    var username by rememberSaveable { mutableStateOf("") }
    // Not saved across process death on purpose: a password shouldn't be written to disk.
    var password by remember { mutableStateOf("") }
    var busy by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var demoRole by rememberSaveable { mutableStateOf(Role.SUPERADMIN) }

    fun signIn() {
        if (serverUrl.isBlank()) { error = "Enter your server's address first"; return }
        if (username.isBlank() || password.isEmpty()) { error = "Enter your username and password"; return }
        busy = true
        error = null
        scope.launch {
            try {
                val url = normaliseBaseUrl(serverUrl)
                val repo = app.remoteRepository(url)
                val config = repo.serverConfig()
                if (config.role == "relay") {
                    throw ApiException(
                        "This is the relay for ${config.siteName ?: "another site"}. Sign in with the main Kiosk server's address instead.",
                    )
                }
                if (config.signIn != "password") {
                    throw ApiException("This server is older than this app. Update the Kiosk add-on to 0.6.0 or newer, then sign in again.")
                }
                val session = repo.signIn(username, password)
                password = ""
                app.startRealSession(url, repo, session.email, session.role)
            } catch (e: ApiException) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }

    Scaffold(snackbarHost = { SnackbarHost(LocalSnackbar.current) }) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(
                    Modifier.size(76.dp).background(MaterialTheme.colorScheme.primary, RoundedCornerShape(22.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Outlined.Tv, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(38.dp))
                }
                Text("Kiosk Admin", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Text(
                    "Choose what plays on every screen, from your phone.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }

            error?.let { message ->
                Surface(color = MaterialTheme.colorScheme.errorContainer, shape = KioskShapes.Medium) {
                    Row(Modifier.padding(14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = MaterialTheme.colorScheme.onErrorContainer)
                        Text(message, color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }

            KioskCard {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Connect to your server", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    OutlinedTextField(
                        value = serverUrl,
                        onValueChange = { serverUrl = it; error = null },
                        label = { Text("Server address") },
                        placeholder = { Text("e.g. 192.168.1.20:3000") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = username,
                        onValueChange = { username = it; error = null },
                        label = { Text("Username") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    PasswordField(value = password, onValueChange = { password = it; error = null }, label = "Password")
                    Button(onClick = ::signIn, enabled = !busy, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                        if (busy) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                        else Text("Sign in")
                    }
                    Text(
                        "Whoever runs Kiosk makes your username and password, on the Users page.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            KioskCard {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Try the demo", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text(
                        "Sample files, playlists and players, kept on this phone only. Nothing is uploaded anywhere.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text("View as", style = MaterialTheme.typography.labelLarge)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Role.entries.forEach { role ->
                            FilterChip(selected = demoRole == role, onClick = { demoRole = role }, label = { Text(role.label) })
                        }
                    }
                    OutlinedButton(onClick = { app.startDemo(demoRole) }, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                        Text("Start demo")
                    }
                }
            }
        }
    }
}
