package com.kiosk.admin.ui.library

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.CloudUpload
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.kiosk.admin.ui.AccountButton
import com.kiosk.admin.ui.ScreenContext
import com.kiosk.admin.ui.common.KioskCard
import com.kiosk.admin.ui.common.SectionLabel
import com.kiosk.admin.ui.common.ShowMessage
import com.kiosk.admin.ui.common.formatBytes
import com.kiosk.admin.ui.common.timeAgo
import com.kiosk.admin.ui.theme.KioskShapes
import com.kiosk.admin.ui.theme.LocalKioskColors
import com.kiosk.core.model.Media
import com.kiosk.core.model.MediaType
import com.kiosk.core.model.ScreenShape

@Composable
fun LibraryRoute(ctx: ScreenContext) {
    val vm = viewModel(key = "library-${ctx.session.id}") { LibraryViewModel(ctx.session.repo, ctx.signOut) }
    val state by vm.state.collectAsStateWithLifecycle()
    val message by vm.message.collectAsStateWithLifecycle()
    ShowMessage(message, vm::messageShown)

    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) vm.upload(context.uploadSourceFor(uri))
    }
    LibraryScreen(
        ctx = ctx,
        state = state,
        onRefresh = vm::syncNow,
        onPickFile = { picker.launch(arrayOf("video/mp4", "image/jpeg", "image/png", "image/webp")) },
        onDelete = { vm.delete(it.id, it.filename) },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(
    ctx: ScreenContext,
    state: LibraryUiState,
    onRefresh: () -> Unit,
    onPickFile: () -> Unit,
    onDelete: (Media) -> Unit,
) {
    var showAdd by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<Media?>(null) }

    Scaffold(
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0),
        topBar = { TopAppBar(title = { Text("Library") }, actions = { AccountButton(ctx) }) },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { showAdd = true },
                icon = { Icon(Icons.Outlined.Add, contentDescription = null) },
                text = { Text("Add") },
            )
        },
    ) { padding ->
        PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = onRefresh, modifier = Modifier.padding(padding).fillMaxSize()) {
            val library = state.library
            if (library == null) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            } else {
            val groups = listOf(
                "Checking shape" to library.items.filter { it.orientation == null },
                "Landscape files" to library.items.filter { it.orientation == ScreenShape.LANDSCAPE },
                "Portrait files" to library.items.filter { it.orientation == ScreenShape.PORTRAIT },
            ).filter { it.second.isNotEmpty() }

            LazyColumn(
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 88.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                item(key = "drive") { DriveCard(library.syncedAt, library.syncError, state.refreshing, onRefresh) }
                state.upload?.let { upload -> item(key = "upload") { UploadCard(upload) } }
                if (groups.isEmpty()) {
                    item(key = "empty") {
                        com.kiosk.admin.ui.common.EmptyState("No files yet", "Tap Add, or drop files into the Signage folder in Google Drive.")
                    }
                }
                groups.forEach { (title, items) ->
                    item(key = "group-$title") {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            SectionLabel("$title · ${items.size}")
                            KioskCard {
                                items.forEachIndexed { i, m ->
                                    if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                                    MediaRow(m, onDelete = { confirmDelete = m })
                                }
                            }
                        }
                    }
                }
            }
            }
        }
    }

    if (showAdd) {
        ModalBottomSheet(onDismissRequest = { showAdd = false }) {
            AddContentSheet(
                onUpload = { showAdd = false; onPickFile() },
                onClose = { showAdd = false },
            )
        }
    }

    confirmDelete?.let { m ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Delete ${m.filename}?") },
            text = { Text("It goes to the Google Drive trash and leaves every playlist. Screens stop showing it after their next update.") },
            confirmButton = {
                TextButton(onClick = { confirmDelete = null; onDelete(m) }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun DriveCard(syncedAt: Long?, syncError: String?, refreshing: Boolean, onRefresh: () -> Unit) {
    KioskCard {
        Row(Modifier.padding(start = 16.dp, top = 12.dp, bottom = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Surface(shape = KioskShapes.Small, color = MaterialTheme.colorScheme.primaryContainer, modifier = Modifier.size(40.dp)) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.Cloud, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
                }
            }
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text("Google Drive · Signage", style = MaterialTheme.typography.titleSmall)
                Text(
                    when {
                        refreshing -> "Syncing…"
                        syncError != null -> syncError
                        else -> "Synced ${timeAgo(syncedAt)}"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = if (syncError != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = onRefresh) { Icon(Icons.Outlined.Refresh, contentDescription = "Sync with Google Drive now") }
        }
    }
}

@Composable
private fun UploadCard(upload: Upload) {
    KioskCard {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row {
                Text("Uploading ${upload.name}", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${(upload.progress * 100).toInt()}%", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            LinearProgressIndicator(progress = { upload.progress }, modifier = Modifier.fillMaxWidth())
            Text("Saving into the Signage folder in Google Drive", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun MediaRow(m: Media, onDelete: () -> Unit) {
    Row(Modifier.padding(start = 12.dp, top = 12.dp, bottom = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        MediaThumb(m.type, m.orientation, 52)
        Column(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(m.filename, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (m.orientation == null) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp)
                Text(mediaMeta(m), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        IconButton(onClick = onDelete) {
            Icon(Icons.Outlined.Delete, contentDescription = "Delete ${m.filename}", tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

fun mediaMeta(m: Media): String =
    (if (m.type == MediaType.VIDEO) "Video" else "Picture") + " · " +
        (m.orientation?.label ?: "Checking shape…") + " · " + formatBytes(m.size)

/** A coloured tile in the file's shape, with a play or picture icon. */
@Composable
fun MediaThumb(type: MediaType, shape: ScreenShape?, sizeDp: Int, label: String? = null) {
    val long = sizeDp.dp
    val short = (sizeDp * 0.72f).dp
    val (w, h) = if (shape == ScreenShape.PORTRAIT) short to long else long to short
    Box(Modifier.size(long), contentAlignment = Alignment.Center) {
        Box(
            Modifier.size(w, h).background(
                if (type == MediaType.VIDEO) MaterialTheme.colorScheme.primary else LocalKioskColors.current.attention,
                RoundedCornerShape(10.dp),
            ),
            contentAlignment = Alignment.Center,
        ) {
            if (label != null) Text(label, color = Color.White, fontWeight = FontWeight.Bold)
            else Icon(
                if (type == MediaType.VIDEO) Icons.Outlined.PlayArrow else Icons.Outlined.Image,
                contentDescription = null,
                tint = Color.White,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

@Composable
private fun AddContentSheet(onUpload: () -> Unit, onClose: () -> Unit) {
    Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("Add content", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Surface(onClick = onUpload, shape = KioskShapes.Large, border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline)) {
            Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.CloudUpload, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Column {
                    Text("Upload from this phone", style = MaterialTheme.typography.titleSmall)
                    Text(
                        "Pick a video or picture. It's saved into the Signage folder in Google Drive.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        Surface(shape = KioskShapes.Large, color = MaterialTheme.colorScheme.surfaceVariant) {
            Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Cloud, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Column {
                    Text("Or add files in Google Drive", style = MaterialTheme.typography.titleSmall)
                    Text(
                        "Anything dropped into the Signage folder shows up here after a sync.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        Text(
            "Works with .mp4 videos up to 4K and .jpg, .png, .webp pictures. Each file is sorted as landscape or portrait from its size.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(onClick = onClose, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Cancel") }
    }
}
