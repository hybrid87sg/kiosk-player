package com.kiosk.player.ui

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
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
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
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.ExoPlayer
import coil.compose.AsyncImage
import com.kiosk.core.model.MediaType
import com.kiosk.core.model.Mounting
import com.kiosk.core.model.ScreenShape
import com.kiosk.player.PlayItem
import com.kiosk.player.PlayerUi
import kotlinx.coroutines.delay

/**
 * Plays the items one after another, forever. Pictures stay for their
 * seconds; videos play to the end. Anything that fails to play is skipped.
 */
@Composable
fun PlaybackScreen(state: PlayerUi.Playing, onNowPlaying: (Long?) -> Unit, onOpenSettings: () -> Unit) {
    val items = state.items
    var position by remember(items) { mutableIntStateOf(0) }
    var plays by remember(items) { mutableIntStateOf(0) } // goes up every step, even with one item
    val item = items[position % items.size]
    val next: () -> Unit = {
        position = (position + 1) % items.size
        plays++
    }
    LaunchedEffect(item.id, plays) { onNowPlaying(item.id) }

    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    Box(Modifier.fillMaxSize().background(Color.Black).openSettingsOnOk(onOpenSettings, focus)) {
        MountedScreen(state.mounting) {
            when {
                item.demoColor != null -> {
                    LaunchedEffect(plays) { delay(item.seconds * 1000L); next() }
                    Fitted(item.shape, state.mounting) { DemoSlide(item) }
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
                else -> VideoPlayer(item, plays, onEnded = next)
            }
            state.badge?.let { Badge(it, Modifier.align(Alignment.TopEnd)) }
        }
    }
}

/**
 * The TV box always sends a landscape picture. When the TV hangs on its side,
 * we draw everything in a portrait-shaped box and turn it to match, so it looks
 * upright to people in the room.
 */
@Composable
private fun MountedScreen(mounting: Mounting, content: @Composable androidx.compose.foundation.layout.BoxScope.() -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val sideways = mounting.rotationDegrees == 90 || mounting.rotationDegrees == 270
        val width = if (sideways) maxHeight else maxWidth
        val height = if (sideways) maxWidth else maxHeight
        Box(
            Modifier
                .requiredSize(width, height)
                .graphicsLayer { rotationZ = -mounting.rotationDegrees.toFloat() },
            content = content,
        )
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

/**
 * Plays one video file with ExoPlayer, which uses the TV box's hardware video
 * decoder (needed for smooth 4K). It draws into a TextureView, which, unlike
 * the default SurfaceView, can be turned for portrait screens.
 */
@Composable
private fun VideoPlayer(item: PlayItem, plays: Int, onEnded: () -> Unit) {
    val context = LocalContext.current
    val currentOnEnded by rememberUpdatedState(onEnded)
    var aspect by remember { mutableFloatStateOf(16f / 9f) }
    val player = remember { ExoPlayer.Builder(context).build() }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) currentOnEnded()
            }
            override fun onPlayerError(error: PlaybackException) = currentOnEnded()
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
