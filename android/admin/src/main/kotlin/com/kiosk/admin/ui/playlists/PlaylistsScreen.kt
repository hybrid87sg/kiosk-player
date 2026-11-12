package com.kiosk.admin.ui.playlists

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.kiosk.admin.ui.AccountButton
import com.kiosk.admin.ui.ScreenContext
import com.kiosk.admin.ui.common.EmptyState
import com.kiosk.admin.ui.common.KioskCard
import com.kiosk.admin.ui.common.SectionLabel
import com.kiosk.admin.ui.common.ShapeIcon
import com.kiosk.admin.ui.common.ShowMessage
import com.kiosk.admin.ui.theme.KioskShapes
import com.kiosk.core.model.PlaylistSummary
import com.kiosk.core.model.ScreenShape

@Composable
fun PlaylistsRoute(ctx: ScreenContext, onOpen: (Long) -> Unit) {
    val vm = viewModel(key = "playlists-${ctx.session.id}") { PlaylistsViewModel(ctx.session.repo, ctx.signOut) }
    val playlists by vm.playlists.collectAsStateWithLifecycle()
    val message by vm.message.collectAsStateWithLifecycle()
    ShowMessage(message, vm::messageShown)
    // Coming back from a playlist: refresh counts and "plays on".
    androidx.compose.runtime.LaunchedEffect(Unit) { vm.load() }
    PlaylistsScreen(ctx, playlists, onOpen, onCreate = { name, shape, locationId -> vm.create(name, shape, locationId, onOpen) })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlaylistsScreen(
    ctx: ScreenContext,
    playlists: List<PlaylistSummary>?,
    onOpen: (Long) -> Unit,
    onCreate: (String, ScreenShape, Long) -> Unit,
) {
    var showNew by remember { mutableStateOf(false) }
    // Playlists belong to a location. Every location has its automatic two, so the
    // list of playlists names every location: (id, name) pairs, in the server's order.
    val placed = playlists.orEmpty().filter { !it.unassigned && it.locationId != null }
    val locations = placed.map { it.locationId!! to it.location.orEmpty() }.distinct()
    val older = playlists.orEmpty().filter { it.unassigned }
    var newLocation by remember(locations) { mutableStateOf(locations.firstOrNull()?.first) }
    Scaffold(
        contentWindowInsets = WindowInsets(0),
        topBar = { TopAppBar(title = { Text("Playlists") }, actions = { AccountButton(ctx) }) },
        floatingActionButton = {
            // An extra playlist is made for a location, so there has to be one first.
            if (locations.isNotEmpty()) ExtendedFloatingActionButton(
                onClick = { showNew = true },
                icon = { Icon(Icons.Outlined.Add, contentDescription = null) },
                text = { Text("Extra playlist") },
            )
        },
    ) { padding ->
        if (playlists == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        } else {
            LazyColumn(
                Modifier.padding(padding),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 88.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item {
                    Text(
                        "Each location's screens play its Landscape or Portrait playlist by themselves. An extra playlist is for a screen that should show something different.",
                        Modifier.padding(horizontal = 4.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (playlists.isEmpty()) {
                    item { EmptyState("No playlists yet", "Add a location on the web page, or when setting up a player. Each location gets a Landscape and a Portrait playlist.") }
                }
                locations.forEach { (id, name) ->
                    item(key = "location-$id") { SectionLabel(name, Modifier.padding(top = 8.dp)) }
                    items(placed.filter { it.locationId == id }, key = { it.id }) { p -> PlaylistCard(p) { onOpen(p.id) } }
                }
                if (older.isNotEmpty()) {
                    item(key = "older") { SectionLabel("Playlists without a location", Modifier.padding(top = 8.dp)) }
                    items(older, key = { it.id }) { p -> PlaylistCard(p) { onOpen(p.id) } }
                }
            }
        }
    }

    if (showNew) {
        ModalBottomSheet(onDismissRequest = { showNew = false }) {
            PlaylistForm(
                title = "Extra playlist for ${locations.firstOrNull { it.first == newLocation }?.second ?: "a location"}",
                initialName = "",
                initialShape = ScreenShape.LANDSCAPE,
                button = "Create",
                onSubmit = { name, shape -> newLocation?.let { id -> showNew = false; onCreate(name, shape, id) } },
                onCancel = { showNew = false },
                extra = {
                    // With several locations, choose which one the playlist is for.
                    if (locations.size > 1) {
                        Text("Location", style = MaterialTheme.typography.labelLarge)
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            locations.forEach { (id, name) ->
                                Row(
                                    Modifier.fillMaxWidth().heightIn(min = 48.dp)
                                        .selectable(selected = newLocation == id, role = Role.RadioButton) { newLocation = id },
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    RadioButton(selected = newLocation == id, onClick = null)
                                    Text(name, Modifier.padding(start = 8.dp))
                                }
                            }
                        }
                    }
                    Text(
                        "Screens don't play an extra playlist by themselves. After making it, edit a player and choose it there.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                },
            )
        }
    }
}

@Composable
private fun PlaylistCard(p: PlaylistSummary, onClick: () -> Unit) {
    KioskCard {
        Surface(onClick = onClick, color = androidx.compose.ui.graphics.Color.Transparent) {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Box(Modifier.width(36.dp), contentAlignment = Alignment.Center) {
                    ShapeIcon(p.orientation, 30.dp, MaterialTheme.colorScheme.primary)
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(p.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        (if (p.auto) "Automatic · " else "") + "${p.orientation.label} · ${p.itemCount} item${if (p.itemCount == 1) "" else "s"}",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(playsOn(p.devices.mapNotNull { it.name }), style = MaterialTheme.typography.bodySmall)
                }
                Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

fun playsOn(names: List<String>): String =
    if (names.isEmpty()) "Not playing on any player yet" else "Plays on ${names.joinToString()}"

/** Name + shape form, used for "New playlist" and "Playlist settings". */
@Composable
fun PlaylistForm(
    title: String,
    initialName: String,
    initialShape: ScreenShape,
    button: String,
    onSubmit: (String, ScreenShape) -> Unit,
    onCancel: () -> Unit,
    extra: @Composable () -> Unit = {},
) {
    var name by rememberSaveable { mutableStateOf(initialName) }
    var shape by rememberSaveable { mutableStateOf(initialShape) }
    var nameError by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().imePadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        OutlinedTextField(
            value = name,
            onValueChange = { name = it; nameError = false },
            label = { Text("Playlist name") },
            placeholder = { Text("e.g. Menu boards") },
            singleLine = true,
            isError = nameError,
            supportingText = { if (nameError) Text("Give the playlist a name") },
            modifier = Modifier.fillMaxWidth(),
        )
        Text("Made for", style = MaterialTheme.typography.labelLarge)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ScreenShape.entries.forEach { s ->
                ShapeChoice(
                    selected = shape == s,
                    shape = s,
                    title = s.label,
                    subtitle = if (s == ScreenShape.LANDSCAPE) "Wide screens" else "Screens on their side",
                    onClick = { shape = s },
                    modifier = Modifier.weight(1f),
                )
            }
        }
        extra()
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onCancel) { Text("Cancel") }
            Button(onClick = { if (name.isBlank()) nameError = true else onSubmit(name.trim(), shape) }, modifier = Modifier.height(48.dp)) { Text(button) }
        }
    }
}

/** A selectable card showing a shape outline, used for playlist and screen shapes. */
@Composable
fun ShapeChoice(
    selected: Boolean,
    shape: ScreenShape,
    title: String,
    subtitle: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        selected = selected,
        onClick = onClick,
        modifier = modifier,
        shape = KioskShapes.Medium,
        color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer,
        border = BorderStroke(if (selected) 2.dp else 1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ShapeIcon(shape, 32.dp, if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant)
            Text(title, style = MaterialTheme.typography.titleSmall)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
