package com.kiosk.admin.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.automirrored.outlined.PlaylistPlay
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Tv
import androidx.compose.material.icons.outlined.VideoLibrary
import androidx.compose.material3.AssistChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.kiosk.admin.AdminSession
import com.kiosk.admin.KioskAdminApplication
import com.kiosk.admin.ui.common.LocalSnackbar
import com.kiosk.admin.ui.library.LibraryRoute
import com.kiosk.admin.ui.players.PlayersRoute
import com.kiosk.admin.ui.playlists.PlaylistDetailRoute
import com.kiosk.admin.ui.playlists.PlaylistsRoute
import com.kiosk.admin.ui.signin.SignInScreen
import com.kiosk.admin.ui.users.UsersRoute
import com.kiosk.core.model.Role
import kotlinx.coroutines.launch

enum class Tab(val label: String, val icon: ImageVector) {
    LIBRARY("Library", Icons.Outlined.VideoLibrary),
    PLAYLISTS("Playlists", Icons.AutoMirrored.Outlined.PlaylistPlay),
    PLAYERS("Players", Icons.Outlined.Tv),
    USERS("Users", Icons.Outlined.Group),
}

/** Which tabs a role may see. */
fun tabsFor(role: Role): List<Tab> = listOfNotNull(
    Tab.LIBRARY,
    Tab.PLAYLISTS,
    Tab.PLAYERS.takeIf { role.canManagePlayers },
    Tab.USERS.takeIf { role.canManageUsers },
)

@Composable
fun AdminApp(app: KioskAdminApplication) {
    val snackbar = remember { SnackbarHostState() }
    CompositionLocalProvider(LocalSnackbar provides snackbar) {
        val session = app.session
        if (session == null) {
            SignInScreen(app)
        } else {
            // A new session (sign-in, demo, role switch) gets fresh screens.
            key(session.id, session.role) { MainScreen(app, session) }
        }
    }
}

/** What the screens need to share: the session, and a way to sign out. */
class ScreenContext(val session: AdminSession, val signOut: () -> Unit, val openAccount: () -> Unit)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainScreen(app: KioskAdminApplication, session: AdminSession) {
    val scope = rememberCoroutineScope()
    val tabs = tabsFor(session.role)
    var tab by rememberSaveable { mutableStateOf(Tab.LIBRARY) }
    if (tab !in tabs) tab = Tab.LIBRARY
    var openPlaylistId by rememberSaveable { mutableStateOf<Long?>(null) }
    var showAccount by rememberSaveable { mutableStateOf(false) }
    val signOut: () -> Unit = { scope.launch { app.signOut() } }
    val ctx = remember(session) { ScreenContext(session, signOut) { showAccount = true } }

    BackHandler(enabled = openPlaylistId != null) { openPlaylistId = null }

    Scaffold(
        contentWindowInsets = WindowInsets(0),
        snackbarHost = { SnackbarHost(LocalSnackbar.current) },
        bottomBar = {
            NavigationBar {
                tabs.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t; openPlaylistId = null },
                        icon = { Icon(t.icon, contentDescription = null) },
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (tab) {
                Tab.LIBRARY -> LibraryRoute(ctx)
                Tab.PLAYLISTS -> {
                    val id = openPlaylistId
                    if (id == null) PlaylistsRoute(ctx, onOpen = { openPlaylistId = it })
                    else PlaylistDetailRoute(ctx, id, onBack = { openPlaylistId = null })
                }
                Tab.PLAYERS -> PlayersRoute(ctx)
                Tab.USERS -> UsersRoute(ctx)
            }
        }
    }

    if (showAccount) {
        ModalBottomSheet(onDismissRequest = { showAccount = false }) {
            AccountSheet(
                session = session,
                onSwitchRole = { role -> showAccount = false; app.switchDemoRole(role) },
                onSignOut = { showAccount = false; signOut() },
                onClose = { showAccount = false },
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AccountSheet(session: AdminSession, onSwitchRole: (Role) -> Unit, onSignOut: () -> Unit, onClose: () -> Unit) {
    Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Avatar(session.email, 48)
            Column {
                Text(session.email, style = MaterialTheme.typography.titleMedium)
                Text(
                    session.role.label + if (session.isDemo) " · Demo mode" else "",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (session.isDemo) {
            Text("Demo: view the app as", style = MaterialTheme.typography.labelLarge)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Role.entries.forEach { role ->
                    FilterChip(selected = session.role == role, onClick = { onSwitchRole(role) }, label = { Text(role.label) })
                }
            }
        }
        OutlinedButton(onClick = onSignOut, modifier = Modifier.fillMaxWidth().height(52.dp)) {
            Icon(Icons.AutoMirrored.Outlined.Logout, contentDescription = null)
            Text(if (session.isDemo) "  Leave demo" else "  Sign out")
        }
        TextButton(onClick = onClose, modifier = Modifier.fillMaxWidth()) { Text("Close") }
    }
}

/** The round initial shown for a person. */
@Composable
fun Avatar(email: String, sizeDp: Int, highlighted: Boolean = true) {
    Surface(
        shape = CircleShape,
        color = if (highlighted) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
        contentColor = if (highlighted) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.size(sizeDp.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(email.take(1).uppercase(), fontWeight = FontWeight.Bold)
        }
    }
}

/** The account button on the right of each screen's top bar. */
@Composable
fun AccountButton(ctx: ScreenContext) {
    AssistChip(
        onClick = ctx.openAccount,
        label = { Text(ctx.session.role.label + if (ctx.session.isDemo) " · Demo" else "") },
        leadingIcon = { Avatar(ctx.session.email, 24) },
        modifier = Modifier.padding(end = 8.dp),
    )
}
