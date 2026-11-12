package com.kiosk.admin.ui.users

import com.kiosk.admin.ui.common.PasswordField
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ArrowDropDown
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import com.kiosk.admin.ui.theme.KioskShapes
import com.kiosk.core.data.AdminRepository
import com.kiosk.core.model.Role
import com.kiosk.core.model.User
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class UsersViewModel(private val repo: AdminRepository, onSignedOut: () -> Unit) : KioskViewModel(onSignedOut) {
    private val _users = MutableStateFlow<List<User>?>(null)
    val users: StateFlow<List<User>?> = _users

    init { launchSafely { _users.value = repo.users() } }

    fun add(username: String, role: Role, password: String, onDone: () -> Unit) = launchSafely {
        val user = repo.addUser(username, role, password)
        _users.value = repo.users()
        onDone()
        say("${user.email} can sign in now. Tell them their username and password.")
    }

    fun setPassword(user: User, password: String, onDone: () -> Unit) = launchSafely {
        repo.setPassword(user.id, password)
        onDone()
        say("${user.email} has a new password and was signed out everywhere")
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
    var passwordFor by remember { mutableStateOf<User?>(null) }

    Scaffold(
        contentWindowInsets = WindowInsets(0),
        topBar = { TopAppBar(title = { Text("Users") }, actions = { AccountButton(ctx) }) },
    ) { padding ->
        LazyColumn(
            Modifier.padding(padding),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item {
                Button(onClick = { showInvite = true }, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                    Icon(Icons.Outlined.Add, contentDescription = null)
                    Spacer(Modifier.width(ButtonDefaults.IconSpacing))
                    Text("Add someone")
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
                                UserRow(
                                    u, isMe = u.email == ctx.session.email,
                                    onRole = { vm.changeRole(u, it) }, onPassword = { passwordFor = u }, onRemove = { vm.remove(u) },
                                )
                            }
                        }
                    }
                }
            }
            item {
                Surface(shape = KioskShapes.Large, color = MaterialTheme.colorScheme.surfaceVariant) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SectionLabel("What each role can do")
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
            AddUserForm(onAdd = { username, role, password -> vm.add(username, role, password) { showInvite = false } }, onCancel = { showInvite = false })
        }
    }
    passwordFor?.let { user ->
        ModalBottomSheet(onDismissRequest = { passwordFor = null }) {
            NewPasswordForm(user, onSave = { password -> vm.setPassword(user, password) { passwordFor = null } }, onCancel = { passwordFor = null })
        }
    }
}

@Composable
private fun UserRow(u: User, isMe: Boolean, onRole: (Role) -> Unit, onPassword: () -> Unit, onRemove: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.padding(start = 14.dp, top = 12.dp, bottom = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Avatar(u.email, 40, highlighted = isMe)
        Column(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(u.email, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (isMe) {
                Text("You · ${u.role.label}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Box {
                    OutlinedButton(onClick = { menu = true }, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(u.role.label)
                        Icon(Icons.Outlined.ArrowDropDown, contentDescription = null)
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        Role.entries.forEach { r ->
                            DropdownMenuItem(text = { Text(r.label) }, onClick = { menu = false; if (r != u.role) onRole(r) })
                        }
                    }
                }
                TextButton(onClick = onPassword, modifier = Modifier.heightIn(min = 48.dp)) { Text("New password") }
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
private fun AddUserForm(onAdd: (String, Role, String) -> Unit, onCancel: () -> Unit) {
    var username by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var role by rememberSaveable { mutableStateOf(Role.CONTENT_UPLOADER) }
    val valid = Regex("^[A-Za-z0-9][A-Za-z0-9._@-]{2,39}$").matches(username.trim()) && password.length >= 8
    Column(Modifier.fillMaxWidth().imePadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("Add someone", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        OutlinedTextField(
            value = username, onValueChange = { username = it },
            label = { Text("Username") }, placeholder = { Text("e.g. patrick") },
            supportingText = { Text("3 to 40 letters or digits") },
            singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth(),
        )
        PasswordField(
            value = password, onValueChange = { password = it }, label = "Password",
            supportingText = "At least 8 characters. Kiosk can't show it again, so note it down for them.",
        )
        Text("Role", style = MaterialTheme.typography.labelLarge)
        Role.entries.forEach { r ->
            Surface(
                shape = KioskShapes.Medium,
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
            Button(onClick = { onAdd(username.trim(), role, password) }, enabled = valid, modifier = Modifier.height(48.dp)) { Text("Add user") }
        }
    }
}

/** Spongebob gives someone a new password; they are signed out everywhere. */
@Composable
private fun NewPasswordForm(user: User, onSave: (String) -> Unit, onCancel: () -> Unit) {
    var password by remember { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().imePadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("New password for ${user.email}", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        PasswordField(
            value = password, onValueChange = { password = it }, label = "New password",
            supportingText = "At least 8 characters. Tell them the new password yourself.",
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onCancel) { Text("Cancel") }
            Button(onClick = { onSave(password) }, enabled = password.length >= 8, modifier = Modifier.height(48.dp)) { Text("Set password") }
        }
    }
}
