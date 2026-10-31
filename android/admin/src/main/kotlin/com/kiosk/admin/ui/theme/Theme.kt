// The app's colour palette (the same as the web interface). One look, used
// whether the phone is in light or dark mode.
package com.kiosk.admin.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

// The palette
private val BgMain = Color(0xFF003333) // app background
private val BgSurface = Color(0xFF11384F) // cards, bars, sheets
private val BgElevated = Color(0xFFF3EFEA) // highlighted items (selected tab, chips)
private val BorderColor = Color(0xFFE6E0D6) // borders and dividers
private val TextPrimary = Color(0xFFFFFFFF)
private val TextSecondary = Color(0xFFD4D4D4)
private val AccentPrimary = Color(0xFFD97706) // buttons
private val AccentSecondary = Color(0xFF003333) // text on orange or cream
private val StatusSuccess = Color(0xFF15803D)
private val StatusWarning = Color(0xFFB45309)
private val StatusDanger = Color(0xFFB91C1C)

private val Palette = darkColorScheme(
    primary = AccentPrimary,
    onPrimary = AccentSecondary,
    primaryContainer = BgElevated,
    onPrimaryContainer = AccentSecondary,
    secondary = AccentPrimary,
    onSecondary = AccentSecondary,
    secondaryContainer = BgElevated,
    onSecondaryContainer = AccentSecondary,
    background = BgMain,
    onBackground = TextPrimary,
    surface = BgMain,
    onSurface = TextPrimary,
    surfaceVariant = BgSurface,
    onSurfaceVariant = TextSecondary,
    surfaceContainerLowest = BgSurface,
    surfaceContainerLow = BgSurface,
    surfaceContainer = BgSurface,
    surfaceContainerHigh = BgSurface,
    surfaceContainerHighest = BgSurface,
    outline = BorderColor,
    outlineVariant = BorderColor.copy(alpha = 0.28f),
    // The red is too dark to read as text on navy: text uses a light tint of it.
    error = Color(0xFFFCA5A5),
    onError = AccentSecondary,
    errorContainer = StatusDanger,
    onErrorContainer = Color.White,
)

/** Extra colours Material doesn't have: "attention" (pending) and "online". */
@Immutable
data class KioskColors(
    val attention: Color,
    val attentionContainer: Color,
    val onAttentionContainer: Color,
    val success: Color,
    val successContainer: Color,
    val onSuccessContainer: Color,
)

private val PaletteExtra = KioskColors(
    attention = AccentPrimary, attentionContainer = StatusWarning, onAttentionContainer = Color.White,
    // The "online" badge is solid green with white text and a white dot.
    success = Color.White, successContainer = StatusSuccess, onSuccessContainer = Color.White,
)

val LocalKioskColors = staticCompositionLocalOf { PaletteExtra }

@Composable
fun KioskTheme(content: @Composable () -> Unit) {
    androidx.compose.runtime.CompositionLocalProvider(LocalKioskColors provides PaletteExtra) {
        MaterialTheme(colorScheme = Palette, content = content)
    }
}
