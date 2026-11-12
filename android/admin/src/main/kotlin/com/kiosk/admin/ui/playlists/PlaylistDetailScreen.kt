package com.kiosk.admin.ui.playlists

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.DragIndicator
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedIconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.kiosk.admin.ui.ScreenContext
import com.kiosk.admin.ui.common.KioskCard
import com.kiosk.admin.ui.common.ShapeIcon
import com.kiosk.admin.ui.common.ShowMessage
import com.kiosk.admin.ui.library.MediaThumb
import com.kiosk.admin.ui.library.mediaMeta
import com.kiosk.admin.ui.theme.KioskShapes
import com.kiosk.admin.ui.theme.LocalKioskColors
import com.kiosk.core.model.MediaType
import com.kiosk.core.model.ScreenShape

/** Minimum row height. Real rows are often taller; drag math uses the measured height. */
private val RowHeight = 96.dp
private val RowGap = 8.dp
private const val DRAG_SLOP_PX = 20f

@Composable
fun PlaylistDetailRoute(ctx: ScreenContext, id: Long, onBack: () -> Unit) {
    val vm = viewModel(key = "playlist-$id-${ctx.session.id}") { PlaylistDetailViewModel(ctx.session.repo, id, ctx.signOut) }
    val state by vm.state.collectAsStateWithLifecycle()
    val message by vm.message.collectAsStateWithLifecycle()
    ShowMessage(message, vm::messageShown)
    PlaylistDetailScreen(state, vm, onBack)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlaylistDetailScreen(state: PlaylistDetailUiState, vm: PlaylistDetailViewModel, onBack: () -> Unit) {
    val saved = state.saved
    var showAdd by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }

    Scaffold(
        contentWindowInsets = WindowInsets(0),
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back to playlists") } },
                title = { Text(saved?.name ?: "", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                actions = {
                    // A site's automatic playlist has nothing to set: its name and shape are fixed.
                    if (saved?.auto != true) {
                        IconButton(onClick = { showSettings = true }, enabled = saved != null) {
                            Icon(Icons.Outlined.Edit, contentDescription = "Playlist settings")
                        }
                    }
                },
            )
        },
        bottomBar = {
            if (state.dirty) {
                Surface(color = MaterialTheme.colorScheme.surfaceContainer, shadowElevation = 6.dp) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.padding(end = 8.dp).size(8.dp).background(LocalKioskColors.current.attention, CircleShape))
                        Text(
                            "Unsaved changes", Modifier.weight(1f),
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                            color = LocalKioskColors.current.attention, style = MaterialTheme.typography.labelLarge,
                        )
                        TextButton(onClick = vm::undo) { Text("Undo") }
                        Button(onClick = vm::save, enabled = !state.saving, modifier = Modifier.height(48.dp)) {
                            if (state.saving) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) else Text("Save")
                        }
                    }
                }
            }
        },
    ) { padding ->
        if (saved == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        } else {
            Column(
                Modifier.padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(top = 8.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Surface(shape = KioskShapes.Large, color = MaterialTheme.colorScheme.surfaceVariant) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Surface(shape = KioskShapes.Small, color = MaterialTheme.colorScheme.primaryContainer) {
                                Row(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                    ShapeIcon(saved.orientation, 16.dp, MaterialTheme.colorScheme.onPrimaryContainer)
                                    Text(
                                        "  ${saved.orientation.label} screens" + if (saved.auto) " · Automatic" else "",
                                        style = MaterialTheme.typography.labelLarge,
                                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                                    )
                                }
                            }
                            Text(
                                "${state.items.size} item${if (state.items.size == 1) "" else "s"} · loops forever",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Text(playsOn(saved.devices.mapNotNull { it.name }), style = MaterialTheme.typography.bodyMedium)
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    OutlinedButton(onClick = { showAdd = true }) {
                        Icon(Icons.Outlined.Add, contentDescription = null)
                        Text(" Add from library")
                    }
                }
                if (state.items.isEmpty()) {
                    com.kiosk.admin.ui.common.EmptyState(
                        "This playlist is empty",
                        "Its screens show “Waiting for content” until you add something and save.",
                    )
                }
                ReorderableItems(state.items, saved.orientation, vm)
                if (state.items.any { it.orientation != null && it.orientation != saved.orientation }) {
                    Surface(shape = KioskShapes.Medium, color = LocalKioskColors.current.attentionContainer) {
                        Row(Modifier.padding(14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Icon(Icons.Outlined.Warning, contentDescription = null, tint = LocalKioskColors.current.onAttentionContainer)
                            Text(
                                "Marked files are a different shape from this playlist. They'll play with black bars around them.",
                                color = LocalKioskColors.current.onAttentionContainer, style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
                if (state.items.size > 1) {
                    Text(
                        "Hold the dotted handle and drag to reorder, or use the ⋮ menu.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }

    if (showAdd && saved != null) {
        ModalBottomSheet(onDismissRequest = { showAdd = false }) {
            AddFromLibrarySheet(state, saved.name, saved.orientation, onAdd = vm::add, onDone = { showAdd = false })
        }
    }
    if (showSettings && saved != null) {
        ModalBottomSheet(onDismissRequest = { showSettings = false; vm.clearDeleteProblem() }) {
            PlaylistForm(
                title = "Playlist settings",
                initialName = saved.name,
                initialShape = saved.orientation,
                button = "Save",
                onSubmit = { name, shape -> showSettings = false; vm.updateSettings(name, shape) },
                onCancel = { showSettings = false; vm.clearDeleteProblem() },
                extra = {
                    TextButton(onClick = { vm.delete(onDeleted = { showSettings = false; onBack() }) }) {
                        Text("Delete this playlist", color = MaterialTheme.colorScheme.error)
                    }
                    state.deleteProblem?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                },
            )
        }
    }
}

/**
 * The playlist rows. Hold a row's handle and drag it up or down; the other rows
 * slide out of the way, and letting go drops it there. The ⋮ menu offers the
 * same moves for people who can't drag.
 *
 * Each row reports its real height. The held row swaps with a neighbour when
 * their centres cross, and the neighbours slide by the held row's height, so
 * a tall image row and a short video row don't share a 96dp step.
 */
@Composable
private fun ReorderableItems(items: List<EditItem>, playlistShape: ScreenShape, vm: PlaylistDetailViewModel) {
    val density = LocalDensity.current
    val gapPx = with(density) { RowGap.toPx() }
    val fallbackHeightPx = with(density) { RowHeight.toPx() }
    val measuredHeights = remember { mutableStateMapOf<Long, Int>() }
    val heightsPx = items.map { measuredHeights[it.key]?.toFloat() ?: fallbackHeightPx }
    val heightsForGesture by rememberUpdatedState(heightsPx)
    val gapForGesture by rememberUpdatedState(gapPx)
    var dragKey by remember { mutableStateOf<Long?>(null) }
    var dragOffset by remember { mutableFloatStateOf(0f) }
    val dragIndex = items.indexOfFirst { it.key == dragKey }.takeIf { it >= 0 }
    val target = dragIndex?.let { reorderTargetIndex(it, dragOffset, heightsPx, gapPx) }
    val draggedHeightPx = dragIndex?.let { heightsPx[it] } ?: fallbackHeightPx

    Column(verticalArrangement = Arrangement.spacedBy(RowGap)) {
        items.forEachIndexed { index, item ->
            key(item.key) {
                val currentIndex by rememberUpdatedState(index)
                val shift = reorderShiftPx(index, dragIndex, target, draggedHeightPx, gapPx)
                val animatedShift by animateFloatAsState(shift, label = "shift")
                val dragging = item.key == dragKey
                PlaylistRow(
                    item = item,
                    index = index,
                    count = items.size,
                    mismatch = item.orientation != null && item.orientation != playlistShape,
                    dragging = dragging,
                    modifier = Modifier
                        .onSizeChanged { measuredHeights[item.key] = it.height }
                        .zIndex(if (dragging) 1f else 0f)
                        .graphicsLayer {
                            translationY = if (dragging) dragOffset else animatedShift
                            scaleX = if (dragging) 1.02f else 1f
                            scaleY = if (dragging) 1.02f else 1f
                        },
                    handleModifier = Modifier.pointerInput(item.key) {
                        detectDragGestures(
                            onDragStart = { dragKey = item.key; dragOffset = 0f },
                            onDrag = { change, amount ->
                                change.consume()
                                val measured = heightsForGesture
                                val gap = gapForGesture
                                val from = currentIndex.coerceIn(0, measured.lastIndex.coerceAtLeast(0))
                                val maxDown = if (measured.isEmpty()) DRAG_SLOP_PX else reorderReachOffset(from, measured.lastIndex, measured, gap) + DRAG_SLOP_PX
                                val maxUp = if (measured.isEmpty()) -DRAG_SLOP_PX else reorderReachOffset(from, 0, measured, gap) - DRAG_SLOP_PX
                                dragOffset = (dragOffset + amount.y).coerceIn(maxUp, maxDown)
                            },
                            onDragEnd = {
                                val measured = heightsForGesture
                                val from = currentIndex.coerceIn(0, measured.lastIndex.coerceAtLeast(0))
                                val to = if (measured.isEmpty()) from else reorderTargetIndex(from, dragOffset, measured, gapForGesture)
                                vm.move(from, to)
                                dragKey = null
                                dragOffset = 0f
                            },
                            onDragCancel = { dragKey = null; dragOffset = 0f },
                        )
                    },
                    onMoveUp = { vm.move(index, index - 1) },
                    onMoveDown = { vm.move(index, index + 1) },
                    onRemove = { vm.remove(index) },
                    onSeconds = { vm.setSeconds(index, it) },
                )
            }
        }
    }
}

@Composable
private fun PlaylistRow(
    item: EditItem,
    index: Int,
    count: Int,
    mismatch: Boolean,
    dragging: Boolean,
    modifier: Modifier,
    handleModifier: Modifier,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
    onRemove: () -> Unit,
    onSeconds: (Int) -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    Surface(
        modifier = modifier.fillMaxWidth().heightIn(min = RowHeight),
        shape = KioskShapes.Large,
        color = MaterialTheme.colorScheme.surfaceContainer,
        border = BorderStroke(if (dragging) 2.dp else 1.dp, if (dragging) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
        shadowElevation = if (dragging) 10.dp else 0.dp,
    ) {
        Row(Modifier.padding(end = 4.dp).height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically) {
            Box(
                handleModifier.width(44.dp).fillMaxHeight().semantics { contentDescription = "Drag to reorder ${item.filename}" },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Outlined.DragIndicator, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            MediaThumb(item.type, item.orientation, 44, label = "${index + 1}")
            Column(Modifier.weight(1f).padding(horizontal = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (mismatch) {
                        Icon(
                            Icons.Outlined.Warning, contentDescription = "Different shape from this playlist",
                            tint = LocalKioskColors.current.attention, modifier = Modifier.size(16.dp),
                        )
                        Spacer(Modifier.width(4.dp))
                    }
                    Text(item.filename, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (item.type == MediaType.VIDEO) {
                    Text("Video · plays to the end", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedIconButton(onClick = { onSeconds(item.seconds - 1) }, modifier = Modifier.size(48.dp)) {
                            Text("−", style = MaterialTheme.typography.titleMedium)
                        }
                        Text(
                            "${item.seconds} s", Modifier.widthIn(min = 48.dp),
                            maxLines = 1, softWrap = false,
                            style = MaterialTheme.typography.titleSmall,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        )
                        OutlinedIconButton(onClick = { onSeconds(item.seconds + 1) }, modifier = Modifier.size(48.dp)) {
                            Text("+", style = MaterialTheme.typography.titleMedium)
                        }
                    }
                }
            }
            Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, contentDescription = "More options for ${item.filename}") }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("Move up") }, enabled = index > 0, onClick = { menu = false; onMoveUp() })
                    DropdownMenuItem(text = { Text("Move down") }, enabled = index < count - 1, onClick = { menu = false; onMoveDown() })
                    DropdownMenuItem(
                        text = { Text("Remove from playlist", color = MaterialTheme.colorScheme.error) },
                        onClick = { menu = false; onRemove() },
                    )
                }
            }
        }
    }
}

@Composable
private fun AddFromLibrarySheet(
    state: PlaylistDetailUiState,
    playlistName: String,
    shape: ScreenShape,
    onAdd: (Long) -> Unit,
    onDone: () -> Unit,
) {
    val inPlaylist = state.items.map { it.mediaId }.toSet()
    val addable = state.library?.items.orEmpty()
        .filter { it.id !in inPlaylist }
        .sortedBy { if (it.orientation == shape || it.orientation == null) 0 else 1 }
    Column(
        Modifier.fillMaxWidth().imePadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("Add to $playlistName", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text("${shape.label} files are listed first.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (state.library == null) CircularProgressIndicator()
        else if (addable.isEmpty()) Text("Everything in the library is already in this playlist.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        KioskCard {
            addable.forEachIndexed { i, m ->
                if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    MediaThumb(m.type, m.orientation, 44)
                    Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                        Text(m.filename, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(mediaMeta(m), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (m.orientation != null && m.orientation != shape) {
                            Text(
                                "${m.orientation!!.label} file · plays with black bars here",
                                style = MaterialTheme.typography.labelMedium, color = LocalKioskColors.current.attention,
                            )
                        }
                    }
                    FilledTonalButton(onClick = { onAdd(m.id) }) { Text("Add") }
                }
            }
        }
        TextButton(onClick = onDone, modifier = Modifier.fillMaxWidth()) { Text("Done") }
    }
}
