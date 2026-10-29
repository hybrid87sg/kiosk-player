package com.kiosk.admin.ui.users

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role as SemanticsRole
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.kiosk.admin.ui.AccountButton
import com.kiosk.admin.ui.Avatar
import com.kiosk.admin.ui.ScreenContext
import com.kiosk.admin.ui.common.KioskCard
import com.kiosk.admin.ui.common.KioskViewModel
import com.kiosk.admin.ui.common.SectionLabel
import com.kiosk.admin.ui.common.ShowMessage
import com.kiosk.core.data.AdminRepository
import com.kiosk.core.model.Role
import com.kiosk.core.model.User
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class UsersViewModel(private val repo: AdminRepository, onSignedOut: () -> Unit) : KioskViewModel(onSignedOut) {
    private val _users = MutableStateFlow<List<User>?>(null)
    val users: StateFlow<List<User>?> = _users

    init { launchSafely { _users.value = repo.users() } }

    fun invite(email: String, role: Role, onDone: () -> Unit) = launchSafely {
        val user = repo.inviteUser(email, role)
        _users.value = repo.users()
        onDone()
        say("Invited ${user.email}. They can sign in with Google now.")
    }

    fun changeRole(user: User, role: Role) = launchSafely {
        repo.changeRole(user.id, role)
        _users.value = repo.users()
        say("${user.email} is now ${role.label}")
    }

    fun remove(user: User) = launchSafely {
        repo.removeUser(user.id)
        _users.value = repo.users()
        say("${user.email} can no longer sign in")
    }
}

private val roleDescriptions = mapOf(
    Role.SUPERADMIN to "Everything, including people and roles",
    Role.SYSTEM_MANAGER to "Players and content",
    Role.CONTENT_UPLOADER to "Files and playlists only",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UsersRoute(ctx: ScreenContext) {
    val vm = viewModel(key = "users-${ctx.session.id}") { UsersViewModel(ctx.session.repo, ctx.signOut) }
    val users by vm.users.collectAsStateWithLifecycle()
    val message by vm.message.collectAsStateWithLifecycle()
    ShowMessage(message, vm::messageShown)
    var showInvite by remember { mutableStateOf(false) }

    Scaffold(
        contentWindowInsets = WindowInsets(0),
        topBar = { TopAppBar(title = { Text("Users", fontWeight = FontWeight.Bold) }, actions = { AccountButton(ctx) }) },
    ) { padding ->
        LazyColumn(
            Modifier.padding(padding),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 40.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item {
                Button(onClick = { showInvite = true }, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                    Icon(Icons.Outlined.Add, contentDescription = null)
                    Text("  Invite someone")
                }
            }
            item {
                val list = users
                if (list == null) {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SectionLabel("${list.size} ${if (list.size == 1) "person" else "people"}")
                        KioskCard {
                            list.forEachIndexed { i, u ->
                                if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                                UserRow(u, isMe = u.email == ctx.session.email, onRole = { vm.changeRole(u, it) }, onRemove = { vm.remove(u) })
                            }
                        }
                    }
                }
            }
            item {
                Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SectionLabel("What each role can do", Modifier.padding(0.dp))
                        Role.entries.forEach { r ->
                            Text("${r.label} · ${roleDescriptions[r]}", style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }
        }
    }

    if (showInvite) {
        ModalBottomSheet(onDismissRequest = { showInvite = false }) {
            InviteForm(onInvite = { email, role -> vm.invite(email, role) { showInvite = false } }, onCancel = { showInvite = false })
        }
    }
}

@Composable
private fun UserRow(u: User, isMe: Boolean, onRole: (Role) -> Unit, onRemove: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.padding(start = 14.dp, top = 12.dp, bottom = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Avatar(u.email, 40, highlighted = isMe)
        Column(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(u.email, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (isMe) {
                Text("You · ${u.role.label}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Box {
                    OutlinedButton(onClick = { menu = true }, modifier = Modifier.height(36.dp)) { Text(u.role.label + "  ▾") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        Role.entries.forEach { r ->
                            DropdownMenuItem(text = { Text(r.label) }, onClick = { menu = false; if (r != u.role) onRole(r) })
                        }
                    }
                }
            }
        }
        if (!isMe) {
            IconButton(onClick = onRemove) {
                Icon(Icons.Outlined.Delete, contentDescription = "Remove ${u.email}", tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun InviteForm(onInvite: (String, Role) -> Unit, onCancel: () -> Unit) {
    var email by rememberSaveable { mutableStateOf("") }
    var role by rememberSaveable { mutableStateOf(Role.CONTENT_UPLOADER) }
    val valid = Regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$").matches(email.trim())
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("Invite someone", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        OutlinedTextField(
            value = email, onValueChange = { email = it },
            label = { Text("Google account email") }, placeholder = { Text("name@yourcompany.com") },
            singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth(),
        )
        Text("Role", style = MaterialTheme.typography.labelLarge)
        Role.entries.forEach { r ->
            Surface(
                shape = RoundedCornerShape(16.dp),
                color = if (role == r) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer,
                border = BorderStroke(if (role == r) 2.dp else 1.dp, if (role == r) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline),
                modifier = Modifier.fillMaxWidth().selectable(selected = role == r, role = SemanticsRole.RadioButton) { role = r },
            ) {
                Row(Modifier.padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = role == r, onClick = null)
                    Column(Modifier.padding(start = 4.dp)) {
                        Text(r.label, style = MaterialTheme.typography.titleSmall)
                        Text(roleDescriptions[r].orEmpty(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onCancel) { Text("Cancel") }
            Button(onClick = { onInvite(email.trim(), role) }, enabled = valid, modifier = Modifier.height(48.dp)) { Text("Send invite") }
        }
    }
}
