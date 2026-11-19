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
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.material3.Typography
import com.kiosk.player.R
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Density
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
import com.kiosk.player.AppUpdater
import com.kiosk.player.HomeScreen
import com.kiosk.player.KeepInFront
import com.kiosk.player.KioskInput
import com.kiosk.player.PlayerSettings
import com.kiosk.player.PlayerUi
import com.kiosk.player.PlayerViewModel

// The showroom colours, warm dark (0.11.3): the same as the web dashboard's dark theme.
val Accent = Color(0xFFD98A68) // terracotta: buttons, the pairing code, step numbers
val Ink = Color(0xFF29241E) // app background (dark brown), and text on terracotta buttons
val Cream = Color(0xFFFBF8F4) // headings and main text
val Muted = Color(0xFFCFC5B6) // secondary text
val Panel = Color(0xFF3D352C) // surfaces: unselected buttons, panels
val Line = Color(0xFF5A5046) // outlines
val Soft = Color(0xFFCFC5B6) // body text on the background
val Warning = Color(0xFFE3A07F) // problems and hints
val Online = Color(0xFF7DBE8A)

// Fraunces for headings, Instrument Sans for everything else (both SIL Open Font License).
val Headline = FontFamily(
    Font(R.font.fraunces_regular, FontWeight.Normal),
    Font(R.font.fraunces_medium, FontWeight.Medium),
)
val BodyFont = FontFamily(
    Font(R.font.instrument_sans_regular, FontWeight.Normal),
    Font(R.font.instrument_sans_semibold, FontWeight.SemiBold),
    Font(R.font.instrument_sans_bold, FontWeight.Bold),
)

/** Material's text styles, all in Instrument Sans. */
private fun kioskTypography(): Typography = Typography().let { t ->
    Typography(
        displayLarge = t.displayLarge.copy(fontFamily = BodyFont), displayMedium = t.displayMedium.copy(fontFamily = BodyFont),
        displaySmall = t.displaySmall.copy(fontFamily = BodyFont), headlineLarge = t.headlineLarge.copy(fontFamily = BodyFont),
        headlineMedium = t.headlineMedium.copy(fontFamily = BodyFont), headlineSmall = t.headlineSmall.copy(fontFamily = BodyFont),
        titleLarge = t.titleLarge.copy(fontFamily = BodyFont), titleMedium = t.titleMedium.copy(fontFamily = BodyFont),
        titleSmall = t.titleSmall.copy(fontFamily = BodyFont), bodyLarge = t.bodyLarge.copy(fontFamily = BodyFont),
        bodyMedium = t.bodyMedium.copy(fontFamily = BodyFont), bodySmall = t.bodySmall.copy(fontFamily = BodyFont),
        labelLarge = t.labelLarge.copy(fontFamily = BodyFont), labelMedium = t.labelMedium.copy(fontFamily = BodyFont),
        labelSmall = t.labelSmall.copy(fontFamily = BodyFont),
    )
}

@Composable
fun PlayerApp(vm: PlayerViewModel) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val mounting by vm.mounting.collectAsStateWithLifecycle()
    var settingsOpen by rememberSaveable { mutableStateOf(false) }
    // Web Kiosk (0.12.0): a customer is using the web page; staff are typing the PIN.
    var browsing by remember { mutableStateOf(false) }
    var pinPadOpen by remember { mutableStateOf(false) }
    val context = LocalContext.current
    // A web session cut short (power cut, crash) leaves nothing behind for the next customer.
    LaunchedEffect(Unit) { if (vm.isWebKiosk) wipeWebData(context, null) }
    // Staff: 5 quick taps in the top-left corner. With a PIN: the PIN pad. A Web Kiosk without
    // a PIN: straight to settings. A Video Kiosk without a PIN: nothing (touches do nothing).
    LaunchedEffect(Unit) {
        KioskInput.cornerTaps.collect {
            when {
                settingsOpen || pinPadOpen -> Unit
                vm.staffPin != null -> pinPadOpen = true
                vm.isWebKiosk -> { browsing = false; settingsOpen = true }
            }
        }
    }
    val webKiosk = (ui as? PlayerUi.Playing)?.webKiosk
    // Not a Web Kiosk any more (or after hours, or the content changed): back to the playlist.
    LaunchedEffect(webKiosk) { if (webKiosk == null) browsing = false }

    MaterialTheme(
        colorScheme = darkColorScheme(primary = Accent, onPrimary = Ink, background = Ink, surface = Ink),
        typography = kioskTypography(),
    ) {
        Box(Modifier.fillMaxSize().background(Ink)) {
            // Playback turns its own picture (from the playlist); every other screen follows
            // how this TV is mounted, so a portrait TV isn't showing these sideways.
            val state = ui
            if (state is PlayerUi.Playing && browsing && state.webKiosk != null) {
                // The playlist stops (no sound under the page) and starts again afterwards.
                MountedScreen(state.mounting) { WebKioskSession(state.webKiosk, onEnd = { browsing = false }) }
            } else if (state is PlayerUi.Playing) {
                PlaybackScreen(
                    state,
                    onNowPlaying = { vm.currentMediaId = it },
                    onOpenSettings = { settingsOpen = true },
                    onPlaybackProblem = vm::notePlaybackProblem,
                    onPlaybackHealthy = vm::notePlaybackHealthy,
                )
                if (state.webKiosk != null) MountedScreen(state.mounting) { TouchToStart(onStart = { browsing = true }) }
            } else MountedScreen(mounting) { when (state) {
                PlayerUi.Loading -> CenterMessage(title = "Kiosk Player", detail = "Starting…")
                is PlayerUi.Setup -> SetupScreen(state.typeAddress, onFind = vm::findServer, onDemo = vm::chooseDemo, onServer = vm::chooseServer, onTurn = vm::turnPicture)
                is PlayerUi.Finding -> FindingScreen(state, onChoose = vm::chooseFound, onAgain = vm::findServer, onType = vm::typeAddress, onBack = vm::backToSetup)
                is PlayerUi.Pairing -> PairingScreen(
                    state, vm.deviceModelName, mounting,
                    onSettings = { settingsOpen = true }, onStartDemo = vm::startDemoPlayback, onTurn = vm::turnPicture,
                )
                is PlayerUi.Waiting -> CenterMessage(state.name?.uppercase(), state.title, state.detail, state.progress, onSettings = { settingsOpen = true })
                is PlayerUi.Playing -> Unit
                is PlayerUi.Closed -> ClosedScreen(onOpenSettings = { settingsOpen = true })
            } }
            val staffPin = vm.staffPin
            if (pinPadOpen && staffPin != null) {
                MountedScreen(mounting) {
                    StaffPinPad(staffPin, onRight = { pinPadOpen = false; browsing = false; settingsOpen = true }, onCancel = { pinPadOpen = false })
                }
            }
            if (settingsOpen) {
                MountedScreen(mounting) { SettingsPanel(vm, onClose = { settingsOpen = false }) }
            }
        }
    }
}

/** A button that shows a thick white ring when the TV remote is on it. */
@Composable
fun TvButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, primary: Boolean = false, small: Boolean = false) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    Button(
        onClick = onClick,
        interactionSource = interaction,
        shape = RoundedCornerShape(4.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = if (primary) Accent else Panel,
            contentColor = if (primary) Ink else Cream,
        ),
        modifier = modifier
            .height(if (small) 48.dp else 56.dp)
            .border(if (focused) (if (small) 3.dp else 4.dp) else 0.dp, if (focused) Cream else Color.Transparent, RoundedCornerShape(6.dp))
            .padding(4.dp),
    ) {
        Text(text, fontSize = if (small) 17.sp else 20.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun SetupScreen(typeAddress: Boolean, onFind: () -> Unit, onDemo: () -> Unit, onServer: (String) -> Unit, onTurn: () -> Unit) {
    var address by rememberSaveable { mutableStateOf("") }
    var showServer by rememberSaveable(typeAddress) { mutableStateOf(typeAddress) }
    val first = remember { FocusRequester() }
    LaunchedEffect(showServer) { runCatching { first.requestFocus() } }

    Column(
        Modifier.fillMaxSize().padding(64.dp),
        verticalArrangement = Arrangement.spacedBy(28.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Kiosk Player", fontSize = 48.sp, fontFamily = Headline, color = Cream)
        if (!showServer) {
            Text("How should this screen get its content?", fontSize = 24.sp, color = Muted)
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                TvButton("Find my server automatically", onFind, Modifier.focusRequester(first), primary = true)
                TvButton("Type the address", { showServer = true })
                TvButton("Try the demo", onDemo)
            }
            TvButton("Turn picture", onTurn, small = true)
            KeepInFrontSection(Modifier.widthIn(max = 900.dp))
        } else {
            Text("Enter your Kiosk server's address", fontSize = 24.sp, color = Muted)
            OutlinedTextField(
                value = address,
                onValueChange = { address = it },
                singleLine = true,
                placeholder = { Text("e.g. 192.168.1.20:3000", fontSize = 22.sp) },
                textStyle = MaterialTheme.typography.headlineSmall.copy(color = Cream),
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
                Text("Looking for your Kiosk server…", fontSize = 40.sp, fontFamily = Headline, color = Cream)
                Text("Checking every device on this network. This takes a few seconds.", fontSize = 24.sp, color = Muted)
                LinearProgressIndicator(Modifier.widthIn(max = 600.dp).fillMaxWidth(), color = Accent)
                TvButton("Cancel", onBack, Modifier.focusRequester(first))
            }
            found.isEmpty() -> {
                Text("No server found", fontSize = 40.sp, fontFamily = Headline, color = Cream)
                Text(state.problem.orEmpty(), fontSize = 24.sp, color = Muted, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 900.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    TvButton("Search again", onAgain, Modifier.focusRequester(first), primary = true)
                    TvButton("Type the address", onType)
                    TvButton("Back", onBack)
                }
            }
            else -> {
                Text("Which server is this screen for?", fontSize = 40.sp, fontFamily = Headline, color = Cream)
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

/**
 * Lays [content] out at a fixed size (the size a 1080p Android TV gives apps:
 * 960×540, or 540×960 on its side) and scales it to the real screen, so it looks
 * the same on 720p, 1080p and 4K TVs and whatever text size the TV is set to.
 */
@Composable
fun FitToScreen(content: @Composable (portrait: Boolean) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val portrait = maxHeight > maxWidth
        val refWidth = if (portrait) 540.dp else 960.dp
        val refHeight = if (portrait) 960.dp else 540.dp
        val scale = minOf(maxWidth / refWidth, maxHeight / refHeight)
        val density = LocalDensity.current.density
        CompositionLocalProvider(LocalDensity provides Density(density * scale, 1f)) {
            Box(Modifier.size(refWidth, refHeight)) { content(portrait) }
        }
    }
}

@Composable
private fun PairingScreen(
    state: PlayerUi.Pairing,
    model: String,
    mounting: Mounting,
    onSettings: () -> Unit,
    onStartDemo: () -> Unit,
    onTurn: () -> Unit,
) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(state.demo) { runCatching { focus.requestFocus() } }
    val offline = state.problem != null
    FitToScreen { portrait ->
        val qr: @Composable () -> Unit = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.alpha(if (offline) 0.35f else 1f).background(Cream, RoundedCornerShape(6.dp)).padding(18.dp)) {
                    QrCode(state.qrPayload, Modifier.size(252.dp))
                }
                Text(
                    if (offline) "Works again once the server answers" else "Scan in the Kiosk Admin app",
                    fontSize = 15.sp, color = Muted,
                )
            }
        }
        val heading: @Composable (center: Boolean) -> Unit = { center ->
            Column(
                horizontalAlignment = if (center) Alignment.CenterHorizontally else Alignment.Start,
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    (if (state.demo) "Demo · " else "New screen · ") + model,
                    fontSize = 14.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.7.sp, color = Muted,
                )
                Text("Add this screen", fontSize = 44.sp, lineHeight = 50.sp, fontFamily = Headline, color = Cream)
            }
        }
        val code: @Composable (center: Boolean) -> Unit = { center ->
            Column(horizontalAlignment = if (center) Alignment.CenterHorizontally else Alignment.Start) {
                Text("Pairing code", fontSize = 15.sp, color = Muted)
                Text(
                    prettyCode(state.code), fontSize = 64.sp, lineHeight = 70.sp, fontFamily = Headline,
                    letterSpacing = 6.sp, color = Accent, maxLines = 1, modifier = Modifier.alpha(if (offline) 0.5f else 1f),
                )
            }
        }
        val steps: @Composable () -> Unit = {
            if (offline) {
                Row(
                    Modifier.background(Color(0x33D98A68), RoundedCornerShape(4.dp)).border(1.dp, Accent, RoundedCornerShape(4.dp)).padding(horizontal = 16.dp, vertical = 12.dp),
                ) {
                    Column {
                        Text("Can’t reach the Kiosk server", fontSize = 17.sp, fontWeight = FontWeight.Bold, color = Cream)
                        Text(state.problem.orEmpty(), fontSize = 16.sp, color = Soft, maxLines = 3)
                    }
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    PairingStep(1, "On the Kiosk dashboard, open Screens. This TV is waiting under New screens: press Add.")
                    PairingStep(2, if (portrait) "Or scan the QR code with Kiosk Admin, or type the code above." else "Or scan the QR code with Kiosk Admin, or type the code below.")
                }
            }
        }
        val buttons: @Composable (center: Boolean) -> Unit = { center ->
            Column(
                horizontalAlignment = if (center) Alignment.CenterHorizontally else Alignment.Start,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (state.demo) {
                        TvButton("Start demo", onStartDemo, Modifier.focusRequester(focus), primary = true, small = true)
                        TvButton("Settings", onSettings, small = true)
                    } else {
                        TvButton("Settings", onSettings, Modifier.focusRequester(focus), small = true)
                    }
                    TvButton("Turn picture", onTurn, small = true)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(12.dp).background(if (offline) Warning else Online, CircleShape))
                    Text(
                        "  " + (if (offline) "Offline" else if (state.demo) "Demo mode" else "Waiting to be added") + " · ${mounting.label}",
                        fontSize = 15.sp, color = Muted,
                    )
                }
            }
        }
        if (portrait) {
            Column(
                Modifier.fillMaxSize().padding(horizontal = 36.dp, vertical = 48.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                heading(true)
                qr()
                code(true)
                steps()
                buttons(true)
            }
        } else {
            Row(
                Modifier.fillMaxSize().padding(horizontal = 48.dp, vertical = 36.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(56.dp),
            ) {
                qr()
                Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    heading(false)
                    steps()
                    code(false)
                    buttons(false)
                }
            }
        }
    }
}

@Composable
private fun PairingStep(number: Int, text: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.size(28.dp).background(Panel, CircleShape), contentAlignment = Alignment.Center) {
            Text("$number", fontSize = 15.sp, fontWeight = FontWeight.Bold, color = Accent)
        }
        Text(text, fontSize = 18.sp, lineHeight = 25.sp, color = Soft)
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
        Text(title, fontSize = 52.sp, fontFamily = Headline, color = Cream, textAlign = TextAlign.Center)
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
        Modifier.fillMaxSize().background(Color(0xE6140F0B)).onPreviewKeyEvent {
            if (it.type == KeyEventType.KeyUp && it.key == Key.Back) { onClose(); true } else false
        },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier.padding(vertical = 24.dp).background(Ink, RoundedCornerShape(8.dp)).border(1.dp, Line, RoundedCornerShape(8.dp))
                .verticalScroll(rememberScrollState()).padding(48.dp).widthIn(max = 900.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            Text("Settings", fontSize = 40.sp, fontFamily = Headline, color = Cream)
            Text(
                if (vm.isDemo) "Demo mode · no server" else "Server: ${vm.serverUrl ?: "not set"}",
                fontSize = 24.sp, color = Soft,
            )
            Text("Kiosk Player ${BuildConfig.VERSION_NAME}", fontSize = 20.sp, color = Muted)
            KeepInFrontSection()
            HomeScreenSection()
            AppUpdatesSection()
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
        Text("Come back to the front automatically", fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = Cream)
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
        Text("Use as this TV's home screen", fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = Cream)
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

/** The one-time permission that lets the dashboard update this app (0.11.0). */
@Composable
private fun AppUpdatesSection(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var allowed by remember { mutableStateOf(AppUpdater.canInstall(context)) }
    var showAdb by remember { mutableStateOf(false) }
    LifecycleResumeEffect(Unit) {
        allowed = AppUpdater.canInstall(context)
        onPauseOrDispose { }
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("App updates from the dashboard", fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = Cream)
        Text(
            if (allowed) "Allowed · Kiosk Player ${BuildConfig.VERSION_NAME}. New versions are installed when someone presses Update on the dashboard."
            else "Needs “Install unknown apps” for Kiosk Player, so the dashboard can update it without a USB stick.",
            fontSize = 20.sp,
            color = if (allowed) Muted else Warning,
        )
        if (!allowed) {
            TvButton("Allow installing updates", {
                KeepInFront.pauseFor(context, 3) // don't jump back while Android's screen is open
                val activity = context as? Activity
                if (activity == null || !AppUpdater.openPermissionScreen(activity)) showAdb = true
            })
        }
        if (showAdb) {
            Text(
                "This TV hides that setting. From a computer on the same network, run:\n${AppUpdater.ADB_COMMAND}",
                fontSize = 18.sp, color = Warning,
            )
        }
    }
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
        Text("After working hours", fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = Cream)
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
