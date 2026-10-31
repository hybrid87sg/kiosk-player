package com.kiosk.player.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import android.util.Log
import android.view.SurfaceView
import android.view.TextureView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import coil.compose.AsyncImage
import com.kiosk.core.model.MediaType
import com.kiosk.core.model.Mounting
import com.kiosk.core.model.ScreenShape
import com.kiosk.core.player.RefreshMode
import com.kiosk.core.player.chooseDisplayMode
import com.kiosk.core.player.playbackRetryDelayMs
import com.kiosk.player.PlayItem
import com.kiosk.player.PlayerUi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val TAG = "KioskPlayer"

/**
 * Plays the items one after another, forever. Pictures stay for their
 * seconds; videos play to the end. A file that fails is logged, reported,
 * and retried after a wait so a bad file cannot spin the playlist.
 */
@Composable
fun PlaybackScreen(
    state: PlayerUi.Playing,
    onNowPlaying: (Long?) -> Unit,
    onOpenSettings: () -> Unit,
    onPlaybackProblem: (Long?, String) -> Unit = { _, _ -> },
    onPlaybackHealthy: () -> Unit = {},
) {
    val items = state.items
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    // Real files share one player for the whole playlist. Demo slides are drawn
    // one at a time because they are not files.
    val continuous = items.isNotEmpty() && items.all { it.demoColor == null && it.file != null }

    Box(Modifier.fillMaxSize().background(Color.Black).openSettingsOnOk(onOpenSettings, focus)) {
        MountedScreen(state.mounting) {
            if (continuous) {
                ContinuousPlaylist(items, state.mounting, onNowPlaying, onPlaybackProblem, onPlaybackHealthy)
            } else {
                SteppedPlaylist(items, state.mounting, onNowPlaying)
            }
            state.badge?.let { Badge(it, Modifier.align(Alignment.TopEnd)) }
        }
    }
}

/** Demo mode: coloured slides, one after another. */
@Composable
private fun SteppedPlaylist(items: List<PlayItem>, mounting: Mounting, onNowPlaying: (Long?) -> Unit) {
    var position by remember(items) { mutableIntStateOf(0) }
    var plays by remember(items) { mutableIntStateOf(0) }
    val item = items[position % items.size]
    val next: () -> Unit = {
        position = (position + 1) % items.size
        plays++
    }
    LaunchedEffect(item.id, plays) { onNowPlaying(item.id) }
    when {
        item.demoColor != null -> {
            LaunchedEffect(plays) { delay(item.seconds * 1000L); next() }
            Fitted(item.shape, mounting) { DemoSlide(item) }
        }
        item.type == MediaType.IMAGE -> {
            LaunchedEffect(plays) { delay(item.seconds * 1000L); next() }
            AsyncImage(
                model = item.file,
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize(),
                onError = { next() },
            )
        }
        else -> SingleVideo(item, plays, onEnded = next)
    }
}

/**
 * One player, the whole playlist loaded, repeating. The player prepares the
 * next file while the current one plays, so videos do not stop between items.
 */
@Composable
private fun ContinuousPlaylist(
    items: List<PlayItem>,
    mounting: Mounting,
    onNowPlaying: (Long?) -> Unit,
    onPlaybackProblem: (Long?, String) -> Unit,
    onPlaybackHealthy: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val itemsNow by rememberUpdatedState(items)
    val reportNow by rememberUpdatedState(onNowPlaying)
    val reportProblem by rememberUpdatedState(onPlaybackProblem)
    val reportHealthy by rememberUpdatedState(onPlaybackHealthy)
    val failures = remember { intArrayOf(0) }
    val released = remember { booleanArrayOf(false) }
    val retry = remember { arrayOfNulls<Job>(1) }
    var problem by remember { mutableStateOf<String?>(null) }
    var aspect by remember { mutableFloatStateOf(16f / 9f) }

    val player = remember {
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(2_000, 15_000, 500, 1_000)
            .setBackBuffer(0, false)
            .build()
        ExoPlayer.Builder(context)
            .setRenderersFactory(DefaultRenderersFactory(context).setEnableDecoderFallback(true))
            .setLoadControl(loadControl)
            .build()
            .apply {
                repeatMode = Player.REPEAT_MODE_ALL
                videoChangeFrameRateStrategy = C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_ONLY_IF_SEAMLESS
                playWhenReady = true
            }
    }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                mediaItem?.mediaId?.toLongOrNull()?.let(reportNow)
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (!isPlaying) return
                failures[0] = 0
                problem = null
                reportHealthy()
                val fps = player.videoFormat?.frameRate ?: return
                if (fps > 1f) matchDisplayFrameRate(context, fps)
            }

            override fun onVideoSizeChanged(videoSize: VideoSize) {
                if (videoSize.width > 0 && videoSize.height > 0) {
                    aspect = videoSize.width * videoSize.pixelWidthHeightRatio / videoSize.height
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                val list = itemsNow
                val item = list.getOrNull(player.currentMediaItemIndex)
                val message = "${item?.name ?: "Video"}: ${error.errorCodeName}${error.message?.let { ": $it" } ?: ""}"
                Log.e(TAG, message, error)
                reportProblem(item?.id, message)
                failures[0] += 1
                val wait = playbackRetryDelayMs(failures[0])
                problem = "This file hit a problem. Trying another in ${wait / 1000} seconds."
                Log.w(TAG, "Waiting ${wait}ms after a playback error (attempt ${failures[0]})")
                retry[0]?.cancel()
                retry[0] = scope.launch {
                    delay(wait)
                    if (released[0] || player.mediaItemCount <= 0) return@launch
                    val next = (player.currentMediaItemIndex + 1) % player.mediaItemCount
                    runCatching {
                        player.seekTo(next, 0L)
                        player.prepare()
                        player.playWhenReady = true
                    }.onFailure { Log.e(TAG, "Could not move on after a playback error", it) }
                }
            }
        }
        player.addListener(listener)
        onDispose {
            released[0] = true
            retry[0]?.cancel()
            player.removeListener(listener)
            player.clearVideoSurface()
            player.release()
        }
    }

    val playlistKey = items.joinToString("|") { "${it.id}:${it.file?.path}:${it.seconds}:${it.type}" }
    LaunchedEffect(playlistKey) {
        player.setMediaItems(items.map { it.toMediaItem() })
        player.prepare()
        player.playWhenReady = true
        onNowPlaying(items.firstOrNull()?.id)
    }

    val useSurface = mounting.rotationDegrees == 0
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        key(useSurface) {
            AndroidView(
                factory = { ctx ->
                    if (useSurface) {
                        // SurfaceView is the light path: the decoder draws straight to the screen.
                        SurfaceView(ctx).also { player.setVideoSurfaceView(it) }
                    } else {
                        // A turned screen is rotated in Compose. SurfaceView cannot follow that,
                        // so portrait mounting uses a TextureView.
                        TextureView(ctx).also { player.setVideoTextureView(it) }
                    }
                },
                modifier = Modifier.aspectRatio(aspect),
            )
        }
        problem?.let {
            Text(
                it,
                color = Color.White,
                fontSize = 18.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(24.dp)
                    .background(Color(0xCC000000), RoundedCornerShape(12.dp))
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }
}

/** Switches the panel refresh rate when the box supports a matching mode. */
internal fun matchDisplayFrameRate(context: Context, frameRate: Float) {
    val activity = context.findActivity() ?: return
    val display = if (Build.VERSION.SDK_INT >= 30) {
        activity.display
    } else {
        @Suppress("DEPRECATION")
        activity.windowManager.defaultDisplay
    } ?: return
    val current = display.mode
    val modes = display.supportedModes.map {
        RefreshMode(it.modeId, it.physicalWidth, it.physicalHeight, it.refreshRate)
    }
    val chosen = chooseDisplayMode(modes, current.physicalWidth, current.physicalHeight, frameRate) ?: return
    runCatching {
        val attrs = activity.window.attributes
        if (attrs.preferredDisplayModeId == chosen) return
        attrs.preferredDisplayModeId = chosen
        activity.window.attributes = attrs
        Log.i(TAG, "Matched the display to ${frameRate}fps (mode $chosen)")
    }.onFailure { Log.w(TAG, "Couldn't match the display frame rate", it) }
}

private fun Context.findActivity(): Activity? {
    var current: Context = this
    while (current is ContextWrapper) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return null
}

private fun PlayItem.toMediaItem(): MediaItem {
    val file = file ?: return MediaItem.Builder().setMediaId(id.toString()).build()
    return MediaItem.Builder()
        .setUri(android.net.Uri.fromFile(file))
        .setMediaId(id.toString())
        .setMimeType(mimeType())
        .apply {
            if (type == MediaType.IMAGE) setImageDurationMs(seconds.coerceAtLeast(1) * 1000L)
        }
        .build()
}

private fun PlayItem.mimeType(): String = when (file?.extension?.lowercase()) {
    "png" -> MimeTypes.IMAGE_PNG
    "webp" -> MimeTypes.IMAGE_WEBP
    "jpg", "jpeg" -> MimeTypes.IMAGE_JPEG
    else -> MimeTypes.VIDEO_MP4
}

/**
 * The TV box always sends a landscape picture. When the TV hangs on its side,
 * we draw everything in a portrait-shaped box and turn it to match, so it looks
 * upright to people in the room. The rotation is skipped when it is zero:
 * a graphics layer stops a SurfaceView from drawing.
 */
@Composable
private fun MountedScreen(mounting: Mounting, content: @Composable androidx.compose.foundation.layout.BoxScope.() -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val sideways = mounting.rotationDegrees == 90 || mounting.rotationDegrees == 270
        val width = if (sideways) maxHeight else maxWidth
        val height = if (sideways) maxWidth else maxHeight
        val turn = if (mounting.rotationDegrees == 0) {
            Modifier
        } else {
            Modifier.graphicsLayer { rotationZ = -mounting.rotationDegrees.toFloat() }
        }
        Box(Modifier.requiredSize(width, height).then(turn), content = content)
    }
}

/** Keeps a demo slide in its own shape, with black bars if the screen is the other shape. */
@Composable
private fun Fitted(shape: ScreenShape?, mounting: Mounting, content: @Composable () -> Unit) {
    val ratio = if (shape == ScreenShape.PORTRAIT) 9f / 16f else 16f / 9f
    val screenIsPortrait = mounting.shape == ScreenShape.PORTRAIT
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Box(
            if (shape == ScreenShape.PORTRAIT && !screenIsPortrait) Modifier.fillMaxHeight().aspectRatio(ratio)
            else if (shape == ScreenShape.LANDSCAPE && screenIsPortrait) Modifier.fillMaxWidth().aspectRatio(ratio)
            else Modifier.fillMaxSize(),
        ) { content() }
    }
}

@Composable
private fun DemoSlide(item: PlayItem) {
    Column(
        Modifier.fillMaxSize().background(Color(item.demoColor ?: 0xFF333333)).padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            if (item.type == MediaType.VIDEO) Icons.Outlined.PlayArrow else Icons.Outlined.Image,
            contentDescription = null, tint = Color.White, modifier = Modifier.size(96.dp),
        )
        Text(item.name, fontSize = 56.sp, fontWeight = FontWeight.Bold, color = Color.White, textAlign = TextAlign.Center)
        Text(
            "Demo ${if (item.type == MediaType.VIDEO) "video" else "picture"} · ${item.shape?.label ?: ""} · ${item.seconds} s",
            fontSize = 24.sp, color = Color.White.copy(alpha = 0.9f),
        )
    }
}

/** One file at a time. Used only when the playlist is not a list of real files. */
@Composable
private fun SingleVideo(item: PlayItem, plays: Int, onEnded: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val currentOnEnded by rememberUpdatedState(onEnded)
    var aspect by remember { mutableFloatStateOf(16f / 9f) }
    val player = remember { ExoPlayer.Builder(context).build() }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) currentOnEnded()
            }
            override fun onPlayerError(error: PlaybackException) {
                Log.e(TAG, "Playback failed for ${item.name}: ${error.errorCodeName}: ${error.message}", error)
                scope.launch {
                    delay(playbackRetryDelayMs(1))
                    currentOnEnded()
                }
            }
            override fun onVideoSizeChanged(videoSize: VideoSize) {
                if (videoSize.width > 0 && videoSize.height > 0) {
                    aspect = videoSize.width * videoSize.pixelWidthHeightRatio / videoSize.height
                }
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
            player.release()
        }
    }

    LaunchedEffect(item.id, plays) {
        val file = item.file
        if (file == null) { currentOnEnded(); return@LaunchedEffect }
        player.setMediaItem(MediaItem.fromUri(android.net.Uri.fromFile(file)))
        player.prepare()
        player.playWhenReady = true
    }

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        AndroidView(
            factory = { ctx -> TextureView(ctx).also { player.setVideoTextureView(it) } },
            modifier = Modifier.aspectRatio(aspect),
        )
    }
}

@Composable
private fun Badge(text: String, modifier: Modifier) {
    Row(
        modifier.padding(20.dp).background(Color(0x99000000), RoundedCornerShape(18.dp)).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(10.dp).background(if (text.startsWith("Offline")) Color(0xFFFDBA74) else Teal, CircleShape))
        Text("  $text", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
    }
}
