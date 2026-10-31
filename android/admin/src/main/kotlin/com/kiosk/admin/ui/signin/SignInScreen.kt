package com.kiosk.admin.ui.signin

import android.content.Context
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
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
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var serverUrl by rememberSaveable { mutableStateOf(app.savedServerUrl) }
    var busy by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var demoRole by rememberSaveable { mutableStateOf(Role.SUPERADMIN) }

    fun signIn() {
        if (serverUrl.isBlank()) { error = "Enter your server's address first"; return }
        busy = true
        error = null
        scope.launch {
            try {
                val url = normaliseBaseUrl(serverUrl)
                val repo = app.remoteRepository(url)
                val clientId = repo.serverConfig().googleWebClientId
                    ?: throw ApiException("This server isn't set up for Google sign-in yet (GOOGLE_WEB_CLIENT_ID is missing).")
                val idToken = googleIdToken(context, clientId)
                val session = repo.signInWithGoogle(idToken)
                app.startRealSession(url, repo, session.email, session.role)
            } catch (e: ApiException) {
                error = e.message
            } catch (e: GetCredentialCancellationException) {
                error = null // the person closed the Google account picker
            } catch (e: NoCredentialException) {
                error = "No Google account found on this phone. Add one in the phone's Settings, then try again."
            } catch (e: GetCredentialException) {
                error = "Google sign-in didn't work: ${e.message}"
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
                    Button(onClick = ::signIn, enabled = !busy, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                        if (busy) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                        else Text("Sign in with Google")
                    }
                    Text(
                        "Only accounts Spongebob has invited can sign in.",
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

/** Shows Google's account picker and returns the signed "ID token" for our server to check. */
private suspend fun googleIdToken(context: Context, webClientId: String): String {
    val option = GetGoogleIdOption.Builder()
        .setFilterByAuthorizedAccounts(false)
        .setServerClientId(webClientId)
        .build()
    val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
    val credential = CredentialManager.create(context).getCredential(context, request).credential
    if (credential is CustomCredential && credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
        return GoogleIdTokenCredential.createFrom(credential.data).idToken
    }
    throw ApiException("Google sign-in returned something unexpected. Please try again.")
}
