package com.kiosk.admin.ui.players

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.kiosk.admin.ui.AccountButton
import com.kiosk.admin.ui.ScreenContext
import com.kiosk.admin.ui.common.EmptyState
import com.kiosk.admin.ui.common.KioskCard
import com.kiosk.admin.ui.common.LocalSnackbar
import com.kiosk.admin.ui.common.SectionLabel
import com.kiosk.admin.ui.common.ShapeIcon
import com.kiosk.admin.ui.common.ShowMessage
import com.kiosk.admin.ui.common.formatBytes
import com.kiosk.admin.ui.common.timeAgo
import com.kiosk.admin.ui.theme.LocalKioskColors
import com.kiosk.core.model.Device
import com.kiosk.core.model.formatH264Level
import com.kiosk.core.model.Mounting
import com.kiosk.core.model.PlayerSetup
import com.kiosk.core.model.PlaylistSummary
import com.kiosk.core.model.WaitingDevice
import kotlinx.coroutines.launch

/** Which form is open: setting up a newly scanned TV, or editing one. */
private sealed interface PlayerForm {
    data class New(val code: String) : PlayerForm
    data class Edit(val device: Device) : PlayerForm
}

@Composable
fun PlayersRoute(ctx: ScreenContext) {
    val vm = viewModel(key = "players-${ctx.session.id}") { PlayersViewModel(ctx.session.repo, ctx.signOut) }
    val state by vm.state.collectAsStateWithLifecycle()
    val message by vm.message.collectAsStateWithLifecycle()
    ShowMessage(message, vm::messageShown)
    PlayersScreen(ctx, state, vm)
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun PlayersScreen(ctx: ScreenContext, state: PlayersUiState, vm: PlayersViewModel) {
    val context = LocalContext.current
    val snackbar = LocalSnackbar.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var form by remember { mutableStateOf<PlayerForm?>(null) }
    var showPin by remember { mutableStateOf(false) }
    var confirmRemove by remember { mutableStateOf<Device?>(null) }
    // With TVs at more than one site, screens are grouped by site first.
    val manySites = (state.devices.orEmpty().map { it.site } + state.waiting.map { it.site }).distinct().size > 1

    Scaffold(
        contentWindowInsets = WindowInsets(0),
        topBar = { TopAppBar(title = { Text("Players", fontWeight = FontWeight.Bold) }, actions = { AccountButton(ctx) }) },
    ) { padding ->
        LazyColumn(
            Modifier.padding(padding),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item {
                KioskCard {
                    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("Add a player", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Text(
                            "Open Kiosk Player on the TV and let it find the server; it then appears under New TVs waiting. " +
                                "Or scan the QR code it shows, or type its code.",
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Button(
                            onClick = {
                                scanQrCode(
                                    context,
                                    onResult = { code -> form = PlayerForm.New(code) },
                                    onError = { msg -> scope.launch { snackbar.showSnackbar(msg) } },
                                )
                            },
                            modifier = Modifier.fillMaxWidth().height(52.dp),
                        ) {
                            Icon(Icons.Outlined.QrCodeScanner, contentDescription = null)
                            Text("  Scan QR code")
                        }
                        TextButton(onClick = { showPin = true }, modifier = Modifier.fillMaxWidth()) { Text("Enter code instead") }
                        if (ctx.session.isDemo) {
                            TextButton(onClick = { form = PlayerForm.New("kiosk-pair:DEMO42") }, modifier = Modifier.fillMaxWidth()) {
                                Text("Demo: pretend I scanned a TV")
                            }
                        }
                    }
                }
            }
            if (state.waiting.isNotEmpty()) {
                item(key = "waiting") {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SectionLabel("New TVs waiting · ${state.waiting.size}")
                        state.waiting.forEach { w -> WaitingCard(w, manySites) { form = PlayerForm.New(w.pairingCode) } }
                    }
                }
            }
            val devices = state.devices
            if (devices == null) {
                item { Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
            } else if (devices.isEmpty()) {
                item { EmptyState("No players yet", "Scan the QR code on a TV running Kiosk Player to add it.") }
            } else {
                devices.groupBy {
                    val location = it.location?.takeIf { l -> l.isNotBlank() } ?: "No location"
                    if (manySites) "${it.site ?: "This site"} › $location" else location
                }.forEach { (location, group) ->
                    item(key = "loc-$location") {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            SectionLabel("$location · ${group.size}")
                            // The location's working hours (changed on the web page).
                            group.first().hoursSummary?.takeIf { group.first().locationId != null }?.let { hours ->
                                Text(
                                    "Working hours: $hours",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(start = 4.dp),
                                )
                            }
                            group.forEach { d ->
                                DeviceCard(d, onEdit = { form = PlayerForm.Edit(d) }, onRemove = { confirmRemove = d })
                            }
                        }
                    }
                }
            }
        }
    }

    if (showPin) {
        var code by rememberSaveable { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { showPin = false },
            title = { Text("Enter the code on the TV") },
            text = {
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it.uppercase() },
                    placeholder = { Text("K7P-29Q") },
                    singleLine = true,
                    textStyle = MaterialTheme.typography.headlineSmall.copy(letterSpacing = 3.sp, fontWeight = FontWeight.Bold),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = { showPin = false; form = PlayerForm.New(code) },
                    enabled = code.count { it.isLetterOrDigit() } == 6,
                ) { Text("Next") }
            },
            dismissButton = { TextButton(onClick = { showPin = false }) { Text("Cancel") } },
        )
    }

    form?.let { current ->
        ModalBottomSheet(onDismissRequest = { form = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
            PlayerSetupForm(
                form = current,
                playlists = state.playlists,
                knownLocations = state.devices.orEmpty().mapNotNull { it.location }.distinct(),
                busy = state.busy,
                onSubmit = { setup ->
                    when (current) {
                        is PlayerForm.New -> vm.claim(current.code, setup) { form = null }
                        is PlayerForm.Edit -> vm.update(current.device.id, setup) { form = null }
                    }
                },
                onCancel = { form = null },
            )
        }
    }

    confirmRemove?.let { d ->
        AlertDialog(
            onDismissRequest = { confirmRemove = null },
            title = { Text("Remove ${d.name}?") },
            text = { Text("The TV stops getting updates and goes back to showing a new pairing code, so it can be added again later.") },
            confirmButton = {
                TextButton(onClick = { confirmRemove = null; vm.remove(d) }) { Text("Remove", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmRemove = null }) { Text("Cancel") } },
        )
    }
}

/** A TV that found the server by itself; one tap opens its setup form. */
@Composable
private fun WaitingCard(w: WaitingDevice, showSite: Boolean, onAdd: () -> Unit) {
    val code = w.pairingCode.take(3) + "-" + w.pairingCode.drop(3)
    KioskCard {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(w.model ?: "Android TV", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text(
                    (if (showSite && w.site != null) "${w.site} · " else "") + "Showing code $code",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Button(onClick = onAdd) { Text("Add") }
        }
    }
}

@Composable
private fun DeviceCard(d: Device, onEdit: () -> Unit, onRemove: () -> Unit) {
    val extra = LocalKioskColors.current
    KioskCard {
        Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(d.name.orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = if (d.online) extra.successContainer else MaterialTheme.colorScheme.surfaceVariant,
                    contentColor = if (d.online) extra.onSuccessContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                ) {
                    Row(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(8.dp).background(if (d.online) extra.success else MaterialTheme.colorScheme.onSurfaceVariant, CircleShape))
                        Text(
                            when {
                                !d.openNow -> if (d.afterHours == "standby") "  After hours · standby" else "  After hours"
                                d.online -> "  Online"
                                else -> "  Offline · ${timeAgo(d.lastSeen)}"
                            },
                            style = MaterialTheme.typography.labelMedium,
                        )
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ShapeIcon(d.orientation.shape, 18.dp, MaterialTheme.colorScheme.onSurfaceVariant)
                Text("${d.orientation.label} · ${d.playlistName ?: "No playlist"}", style = MaterialTheme.typography.bodyMedium)
            }
            Text(
                d.currentFilename?.let { "Now playing: $it" } ?: "Waiting for content",
                style = MaterialTheme.typography.bodyMedium,
            )
            d.freeBytes?.let {
                Text("Storage: ${formatBytes(it)} free", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            d.decoders?.takeIf { it.displayWidth > 0 }?.let { caps ->
                val level = caps.h264Level?.let { " · H.264 level ${formatH264Level(it)}" }.orEmpty()
                val hevc = if (caps.hevc) " · HEVC" else ""
                Text(
                    "Screen ${caps.displayWidth}×${caps.displayHeight}$level$hevc",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            d.playbackError?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Row {
                TextButton(onClick = onEdit) { Text("Edit") }
                TextButton(onClick = onRemove) { Text("Remove", color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}

/** Name, location, how the screen is mounted, and which playlist it plays. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PlayerSetupForm(
    form: PlayerForm,
    playlists: List<PlaylistSummary>,
    knownLocations: List<String>,
    busy: Boolean,
    onSubmit: (PlayerSetup) -> Unit,
    onCancel: () -> Unit,
) {
    val existing = (form as? PlayerForm.Edit)?.device
    var name by rememberSaveable { mutableStateOf(existing?.name.orEmpty()) }
    var location by rememberSaveable { mutableStateOf(existing?.location.orEmpty()) }
    var mounting by rememberSaveable { mutableStateOf(existing?.orientation ?: Mounting.LANDSCAPE) }
    var playlistId by rememberSaveable { mutableStateOf(existing?.playlistId ?: playlists.firstOrNull()?.id) }
    var nameError by remember { mutableStateOf(false) }
    val chosen = playlists.firstOrNull { it.id == playlistId }

    Column(
        Modifier.fillMaxWidth().imePadding().navigationBarsPadding().verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        if (form is PlayerForm.New) {
            Text(
                "✓ Found player ${form.code.removePrefix("kiosk-pair:")}",
                color = LocalKioskColors.current.success, style = MaterialTheme.typography.labelLarge,
            )
        }
        Text(if (form is PlayerForm.New) "Set up this player" else "Edit player", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        OutlinedTextField(
            value = name, onValueChange = { name = it; nameError = false },
            label = { Text("Name") }, placeholder = { Text("e.g. Front window") },
            singleLine = true, isError = nameError,
            supportingText = { if (nameError) Text("Give the player a name") },
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = location, onValueChange = { location = it },
            label = { Text("Location") }, placeholder = { Text("e.g. Main lobby") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
        )
        if (knownLocations.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                knownLocations.forEach { loc -> FilterChip(selected = location == loc, onClick = { location = loc }, label = { Text(loc) }) }
            }
        }

        Text("How the screen is mounted", style = MaterialTheme.typography.labelLarge)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Mounting.entries.forEach { m ->
                Surface(
                    selected = mounting == m,
                    onClick = { mounting = m },
                    modifier = Modifier.weight(1f).height(100.dp),
                    shape = RoundedCornerShape(16.dp),
                    color = if (mounting == m) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer,
                    border = BorderStroke(if (mounting == m) 2.dp else 1.dp, if (mounting == m) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline),
                ) {
                    Column(Modifier.padding(8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                        ShapeIcon(m.shape, 30.dp, MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(
                            m.label, style = MaterialTheme.typography.labelMedium,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.padding(top = 8.dp),
                        )
                    }
                }
            }
        }
        Text(
            "Kiosk Player turns the picture to match, because TV boxes always send a landscape picture.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Text("Playlist", style = MaterialTheme.typography.labelLarge)
        if (playlists.isEmpty()) {
            Text("No playlists yet. Make one on the Playlists tab; the player waits for content until then.", style = MaterialTheme.typography.bodySmall)
        }
        playlists.forEach { p ->
            Surface(
                shape = RoundedCornerShape(16.dp),
                color = if (playlistId == p.id) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer,
                border = BorderStroke(if (playlistId == p.id) 2.dp else 1.dp, if (playlistId == p.id) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline),
                modifier = Modifier.fillMaxWidth().selectable(selected = playlistId == p.id, role = Role.RadioButton) { playlistId = p.id },
            ) {
                Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = playlistId == p.id, onClick = null)
                    Column(Modifier.padding(start = 4.dp)) {
                        Text(p.name, style = MaterialTheme.typography.titleSmall)
                        Text("${p.orientation.label} · ${p.itemCount} items", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        if (chosen != null && chosen.orientation != mounting.shape) {
            Surface(shape = RoundedCornerShape(12.dp), color = LocalKioskColors.current.attentionContainer) {
                Text(
                    "${chosen.name} is made for ${chosen.orientation.label.lowercase()} screens, but this screen is " +
                        "${mounting.shape.label.lowercase()}. Its files will play with black bars.",
                    Modifier.padding(12.dp),
                    color = LocalKioskColors.current.onAttentionContainer, style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onCancel) { Text("Cancel") }
            Button(
                onClick = {
                    if (name.isBlank()) nameError = true
                    else onSubmit(PlayerSetup(name.trim(), location.trim().ifBlank { null }, mounting, playlistId))
                },
                enabled = !busy,
                modifier = Modifier.height(48.dp),
            ) {
                if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else Text(if (form is PlayerForm.New) "Add player" else "Save")
            }
        }
    }
}
