package com.kiosk.player.ui

import android.app.Activity
import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.kiosk.core.model.Mounting
import com.kiosk.core.player.FoundServer
import com.kiosk.player.BuildConfig
import com.kiosk.player.AfterHours
import com.kiosk.player.HomeScreen
import com.kiosk.player.KeepInFront
import com.kiosk.player.PlayerSettings
import com.kiosk.player.PlayerUi
import com.kiosk.player.PlayerViewModel

// The app's colour palette (the same as the web interface and phone app).
val Accent = Color(0xFFD97706) // primary accent: buttons, the pairing code
val Ink = Color(0xFF003333) // app background, and text on orange buttons
val Muted = Color(0xFFD4D4D4) // secondary text
val Panel = Color(0xFF11384F) // surfaces: unselected buttons, panels
val Soft = Color(0xFFD4D4D4) // body text on the background
val Warning = Color(0xFFD97706) // problems and hints (the warning brown is too dark to read here)
val Online = Color(0xFF15803D)

@Composable
fun PlayerApp(vm: PlayerViewModel) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    var settingsOpen by rememberSaveable { mutableStateOf(false) }

    MaterialTheme(colorScheme = darkColorScheme(primary = Accent, onPrimary = Ink, background = Ink, surface = Ink)) {
        Box(Modifier.fillMaxSize().background(Ink)) {
            when (val state = ui) {
                PlayerUi.Loading -> CenterMessage(title = "Kiosk Player", detail = "Starting…")
                is PlayerUi.Setup -> SetupScreen(state.typeAddress, onFind = vm::findServer, onDemo = vm::chooseDemo, onServer = vm::chooseServer)
                is PlayerUi.Finding -> FindingScreen(state, onChoose = vm::chooseFound, onAgain = vm::findServer, onType = vm::typeAddress, onBack = vm::backToSetup)
                is PlayerUi.Pairing -> PairingScreen(state, onSettings = { settingsOpen = true }, onStartDemo = vm::startDemoPlayback)
                is PlayerUi.Waiting -> CenterMessage(state.name?.uppercase(), state.title, state.detail, state.progress, onSettings = { settingsOpen = true })
                is PlayerUi.Playing -> PlaybackScreen(
                    state,
                    onNowPlaying = { vm.currentMediaId = it },
                    onOpenSettings = { settingsOpen = true },
                    onPlaybackProblem = vm::notePlaybackProblem,
                    onPlaybackHealthy = vm::notePlaybackHealthy,
                )
                is PlayerUi.Closed -> ClosedScreen(onOpenSettings = { settingsOpen = true })
            }
            if (settingsOpen) {
                SettingsPanel(vm, onClose = { settingsOpen = false })
            }
        }
    }
}

/** A button that shows a thick white ring when the TV remote is on it. */
@Composable
fun TvButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, primary: Boolean = false) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    Button(
        onClick = onClick,
        interactionSource = interaction,
        colors = ButtonDefaults.buttonColors(
            containerColor = if (primary) Accent else Panel,
            contentColor = if (primary) Ink else Color.White,
        ),
        modifier = modifier
            .height(56.dp)
            .border(if (focused) 4.dp else 0.dp, if (focused) Color.White else Color.Transparent, RoundedCornerShape(30.dp))
            .padding(4.dp),
    ) {
        Text(text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun SetupScreen(typeAddress: Boolean, onFind: () -> Unit, onDemo: () -> Unit, onServer: (String) -> Unit) {
    var address by rememberSaveable { mutableStateOf("") }
    var showServer by rememberSaveable(typeAddress) { mutableStateOf(typeAddress) }
    val first = remember { FocusRequester() }
    LaunchedEffect(showServer) { runCatching { first.requestFocus() } }

    Column(
        Modifier.fillMaxSize().padding(64.dp),
        verticalArrangement = Arrangement.spacedBy(28.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Kiosk Player", fontSize = 48.sp, fontWeight = FontWeight.Bold, color = Color.White)
        if (!showServer) {
            Text("How should this screen get its content?", fontSize = 24.sp, color = Muted)
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                TvButton("Find my server automatically", onFind, Modifier.focusRequester(first), primary = true)
                TvButton("Type the address", { showServer = true })
                TvButton("Try the demo", onDemo)
            }
            KeepInFrontSection(Modifier.widthIn(max = 900.dp))
        } else {
            Text("Enter your Kiosk server's address", fontSize = 24.sp, color = Muted)
            OutlinedTextField(
                value = address,
                onValueChange = { address = it },
                singleLine = true,
                placeholder = { Text("e.g. 192.168.1.20:3000", fontSize = 22.sp) },
                textStyle = MaterialTheme.typography.headlineSmall.copy(color = Color.White),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { if (address.isNotBlank()) onServer(address) }),
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Accent, unfocusedBorderColor = Muted),
                modifier = Modifier.widthIn(max = 720.dp).fillMaxWidth().focusRequester(first),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                TvButton("Connect", { if (address.isNotBlank()) onServer(address) }, primary = true)
                TvButton("Back", { showServer = false })
            }
        }
    }
}

/** Looking for the Kiosk server on this network, then (if there are several) choosing one. */
@Composable
private fun FindingScreen(
    state: PlayerUi.Finding,
    onChoose: (FoundServer) -> Unit,
    onAgain: () -> Unit,
    onType: () -> Unit,
    onBack: () -> Unit,
) {
    val first = remember { FocusRequester() }
    LaunchedEffect(state.found) { runCatching { first.requestFocus() } }
    Column(
        Modifier.fillMaxSize().padding(64.dp),
        verticalArrangement = Arrangement.spacedBy(28.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        val found = state.found
        when {
            found == null -> {
                Text("Looking for your Kiosk server…", fontSize = 40.sp, fontWeight = FontWeight.Bold, color = Color.White)
                Text("Checking every device on this network. This takes a few seconds.", fontSize = 24.sp, color = Muted)
                LinearProgressIndicator(Modifier.widthIn(max = 600.dp).fillMaxWidth(), color = Accent)
                TvButton("Cancel", onBack, Modifier.focusRequester(first))
            }
            found.isEmpty() -> {
                Text("No server found", fontSize = 40.sp, fontWeight = FontWeight.Bold, color = Color.White)
                Text(state.problem.orEmpty(), fontSize = 24.sp, color = Muted, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 900.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    TvButton("Search again", onAgain, Modifier.focusRequester(first), primary = true)
                    TvButton("Type the address", onType)
                    TvButton("Back", onBack)
                }
            }
            else -> {
                Text("Which server is this screen for?", fontSize = 40.sp, fontWeight = FontWeight.Bold, color = Color.White)
                Text("More than one Kiosk server answered on this network.", fontSize = 24.sp, color = Muted)
                found.forEachIndexed { i, server ->
                    val name = server.siteName ?: "Kiosk server"
                    val kind = if (server.role == "relay") "site relay" else "main server"
                    TvButton(
                        "$name · $kind · ${server.url.removePrefix("http://").trimEnd('/')}",
                        { onChoose(server) },
                        if (i == 0) Modifier.focusRequester(first) else Modifier,
                        primary = i == 0,
                    )
                }
                TvButton("Back", onBack)
            }
        }
    }
}

@Composable
private fun PairingScreen(state: PlayerUi.Pairing, onSettings: () -> Unit, onStartDemo: () -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(state.demo) { runCatching { focus.requestFocus() } }
    Row(
        Modifier.fillMaxSize().padding(horizontal = 96.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(72.dp),
    ) {
        Box(Modifier.background(Color.White, RoundedCornerShape(24.dp)).padding(24.dp)) {
            QrCode(state.qrPayload, Modifier.size(380.dp))
        }
        Column(verticalArrangement = Arrangement.spacedBy(26.dp)) {
            Text("Add this screen", fontSize = 56.sp, fontWeight = FontWeight.Bold, color = Color.White)
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("It's waiting in Kiosk Signage under New screens:", fontSize = 28.sp, color = Soft)
                Text("click Add there, or scan this QR code in Kiosk Admin", fontSize = 28.sp, color = Soft)
            }
            Column {
                Text("Or type this code", fontSize = 24.sp, color = Muted)
                Text(prettyCode(state.code), fontSize = 80.sp, fontWeight = FontWeight.Bold, letterSpacing = 10.sp, color = Accent)
            }
            state.problem?.let { Text(it, fontSize = 22.sp, color = Warning) }
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.CenterVertically) {
                if (state.demo) {
                    TvButton("Start demo playback", onStartDemo, Modifier.focusRequester(focus), primary = true)
                    TvButton("Settings", onSettings)
                } else {
                    TvButton("Settings", onSettings, Modifier.focusRequester(focus))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(12.dp).background(Online, CircleShape))
                        Text("  Waiting to be added", fontSize = 22.sp, color = Muted)
                    }
                }
            }
        }
    }
}

/** "K7P29Q" -> "K7P-29Q", easier to read and type. */
private fun prettyCode(code: String) = if (code.length == 6) code.substring(0, 3) + "-" + code.substring(3) else code

@Composable
private fun QrCode(payload: String, modifier: Modifier) {
    val bitmap = remember(payload) {
        val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, 512, 512, mapOf(EncodeHintType.MARGIN to 0))
        Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.RGB_565).apply {
            for (x in 0 until matrix.width) for (y in 0 until matrix.height) {
                setPixel(x, y, if (matrix[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
            }
        }.asImageBitmap()
    }
    Image(bitmap, contentDescription = "QR code for pairing this screen", modifier = modifier)
}

@Composable
private fun CenterMessage(
    eyebrow: String? = null,
    title: String,
    detail: String,
    progress: Float? = null,
    onSettings: (() -> Unit)? = null,
) {
    val focus = remember { FocusRequester() }
    if (onSettings != null) LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Column(
        Modifier.fillMaxSize().padding(64.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        eyebrow?.let { Text(it, fontSize = 22.sp, color = Muted, letterSpacing = 3.sp, fontWeight = FontWeight.SemiBold) }
        Text(title, fontSize = 52.sp, fontWeight = FontWeight.Bold, color = Color.White, textAlign = TextAlign.Center)
        Text(detail, fontSize = 26.sp, color = Soft, textAlign = TextAlign.Center)
        if (progress != null) {
            LinearProgressIndicator(progress = { progress }, color = Accent, trackColor = Panel, modifier = Modifier.widthIn(max = 520.dp).fillMaxWidth().height(10.dp))
        }
        if (onSettings != null) TvButton("Settings", onSettings, Modifier.focusRequester(focus))
    }
}

/** Opened with the remote's OK button during playback, or the Settings buttons. */
@Composable
private fun SettingsPanel(vm: PlayerViewModel, onClose: () -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    var confirmReset by remember { mutableStateOf(false) }
    Box(
        Modifier.fillMaxSize().background(Color(0xE6000000)).onPreviewKeyEvent {
            if (it.type == KeyEventType.KeyUp && it.key == Key.Back) { onClose(); true } else false
        },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier.padding(vertical = 24.dp).background(Ink, RoundedCornerShape(28.dp))
                .verticalScroll(rememberScrollState()).padding(48.dp).widthIn(max = 900.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            Text("Settings", fontSize = 40.sp, fontWeight = FontWeight.Bold, color = Color.White)
            Text(
                if (vm.isDemo) "Demo mode · no server" else "Server: ${vm.serverUrl ?: "not set"}",
                fontSize = 24.sp, color = Soft,
            )
            Text("Kiosk Player ${BuildConfig.VERSION_NAME}", fontSize = 20.sp, color = Muted)
            KeepInFrontSection()
            HomeScreenSection()
            AfterHoursSection()
            if (vm.isDemo) {
                Text("Demo: how this screen is mounted", fontSize = 22.sp, color = Muted)
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Mounting.entries.forEach { m ->
                        TvButton(
                            (if (vm.demoMounting == m) "✓ " else "") + m.label,
                            { vm.setDemoMounting(m); onClose() },
                            primary = vm.demoMounting == m,
                        )
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                TvButton("Back", onClose, Modifier.focusRequester(focus), primary = true)
                if (!confirmReset) TvButton(if (vm.isDemo) "Leave demo" else "Change server…", { confirmReset = true })
                else TvButton("Yes, start over", { onClose(); vm.resetEverything() })
            }
            if (confirmReset) {
                Text(
                    "Starting over forgets the server, the pairing and the downloaded files on this TV.",
                    fontSize = 20.sp, color = Warning,
                )
            }
        }
    }
}

/**
 * "Come back to the front automatically": asks for the "Display over other
 * apps" permission, and lets staff switch it off or leave for 15 minutes.
 */
@Composable
private fun KeepInFrontSection(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val settings = remember { PlayerSettings(context) }
    var granted by remember { mutableStateOf(KeepInFront.hasPermission(context)) }
    var enabled by remember { mutableStateOf(settings.keepInFront) }
    var paused by remember { mutableStateOf(KeepInFront.pausedUntil > System.currentTimeMillis()) }
    var showAdb by remember { mutableStateOf(false) }
    // Check again when coming back from Android's permission screen.
    LifecycleResumeEffect(Unit) {
        granted = KeepInFront.hasPermission(context)
        onPauseOrDispose { }
    }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Come back to the front automatically", fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
        Text(
            when {
                !granted -> "Needs the “Display over other apps” permission, so the player can reopen itself after a restart or when someone leaves it."
                !enabled -> "Off"
                paused -> "Paused for 15 minutes"
                else -> "On · returns 30 seconds after someone leaves the app, and reopens within a minute if Android closes it"
            },
            fontSize = 20.sp,
            color = if (!granted) Warning else Muted,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            if (!granted) {
                TvButton("Allow display over other apps", {
                    KeepInFront.pauseFor(context, 3) // don't jump back while the permission screen is open
                    val activity = context as? Activity
                    if (activity == null || !KeepInFront.openPermissionScreen(activity)) showAdb = true
                }, primary = true)
            } else {
                TvButton(if (enabled) "Turn off" else "Turn on", {
                    enabled = !enabled
                    settings.keepInFront = enabled
                })
                if (enabled) {
                    TvButton(if (paused) "Resume now" else "Leave for 15 minutes", {
                        if (paused) KeepInFront.resume(context) else KeepInFront.pauseFor(context, 15)
                        paused = !paused
                    })
                }
                if (!enabled || paused) {
                    TvButton("Open TV settings", { (context as? Activity)?.let(KeepInFront::openTvSettings) })
                }
            }
        }
        if (showAdb) {
            Text(
                "This TV box hides that setting. From a computer on the same network, run:\n${KeepInFront.ADB_COMMAND}",
                fontSize = 18.sp, color = Warning,
            )
        }
        LastRestartNote(settings)
    }
}

/** "Last closed by itself": why Android last closed the player, if it did in the past week. */
@Composable
private fun LastRestartNote(settings: PlayerSettings) {
    val at = settings.lastRestartAt ?: return
    val reason = settings.lastRestartReason ?: return
    if (System.currentTimeMillis() - at > 7 * 24 * 3_600_000L) return
    val time = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT).format(java.util.Date(at))
    Text("Last closed by itself: $time · $reason. It reopened automatically.", fontSize = 18.sp, color = Muted)
}

/**
 * Optional: the player as this TV box's home screen. Android always reopens
 * its home screen, even after a cleaner app force-stops it.
 */
@Composable
private fun HomeScreenSection(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var offered by remember { mutableStateOf(HomeScreen.isOffered(context)) }
    var isDefault by remember { mutableStateOf(HomeScreen.isDefault(context)) }
    var showAdb by remember { mutableStateOf(false) }
    LifecycleResumeEffect(Unit) {
        offered = HomeScreen.isOffered(context)
        isDefault = HomeScreen.isDefault(context)
        onPauseOrDispose { }
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Use as this TV's home screen", fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
        Text(
            when {
                isDefault -> "On · Android reopens the player whatever closes it. The Home button also leads here: use Leave for 15 minutes, then Open TV settings."
                offered -> "Not chosen yet. Pick Kiosk Player as the home screen (choose Always), or run the command below."
                else -> "Off · the strongest protection against the player being closed, for TV boxes with a cleaner app."
            },
            fontSize = 20.sp,
            color = if (offered && !isDefault) Warning else Muted,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            if (!isDefault) {
                TvButton(if (offered) "Choose home screen again" else "Make it the home screen", {
                    val activity = context as? Activity
                    offered = true
                    if (activity == null || !HomeScreen.offer(activity)) showAdb = true
                })
            }
            if (offered || isDefault) {
                TvButton("Stop being the home screen", {
                    HomeScreen.stop(context)
                    offered = false
                    isDefault = HomeScreen.isDefault(context)
                    showAdb = false
                })
            }
        }
        if (showAdb || (offered && !isDefault)) {
            Text(
                "If the TV doesn't ask, from a computer on the same network run:\n${HomeScreen.ADB_COMMAND}",
                fontSize = 18.sp, color = Warning,
            )
        }
    }
}

/**
 * Outside working hours: plain black (nothing to burn into the screen). The
 * remote's OK button still opens settings.
 */
@Composable
private fun ClosedScreen(onOpenSettings: () -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Box(Modifier.fillMaxSize().background(Color.Black).openSettingsOnOk(onOpenSettings, focus))
}

/** The one-time permission that lets the player put the screen into standby after hours. */
@Composable
private fun AfterHoursSection(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var allowed by remember { mutableStateOf(AfterHours.canSleep(context)) }
    var showAdb by remember { mutableStateOf(false) }
    LifecycleResumeEffect(Unit) {
        allowed = AfterHours.canSleep(context)
        onPauseOrDispose { }
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("After working hours", fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
        Text(
            if (allowed) "Black screen, and standby where this TV allows it. It wakes up at opening time."
            else "Black screen. Allow “turn the screen off” to also put the TV into standby where it can.",
            fontSize = 20.sp,
            color = Muted,
        )
        if (!allowed) {
            TvButton("Allow turning the screen off", {
                KeepInFront.pauseFor(context, 3) // don't jump back while Android's screen is open
                val activity = context as? Activity
                if (activity == null || !AfterHours.openPermissionScreen(activity)) showAdb = true
            })
        }
        if (showAdb) {
            Text(
                "This TV hides that setting. From a computer on the same network, run:\n${AfterHours.ADB_COMMAND}",
                fontSize = 18.sp, color = Warning,
            )
        }
    }
}

/** Lets the remote's OK / Enter / Menu buttons open settings while content plays. */
fun Modifier.openSettingsOnOk(onOpen: () -> Unit, focus: FocusRequester): Modifier =
    this.focusRequester(focus).focusable().onPreviewKeyEvent {
        val ok = it.key == Key.DirectionCenter || it.key == Key.Enter || it.key == Key.NumPadEnter || it.key == Key.Menu
        if (ok && it.type == KeyEventType.KeyUp) { onOpen(); true } else ok
    }
