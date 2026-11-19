// The app's colour palette: the Kiosk dark brown look. One look, used whether
// the phone is in light or dark mode.
package com.kiosk.admin.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import com.kiosk.admin.R

// The palette (0.12.0): dark brown and terracotta, the same as the TV app, the Windows
// kiosk and the web dashboard's dark theme.
private val BgMain = Color(0xFF29241E) // app background
private val BgSurface = Color(0xFF332D26) // cards, bars, sheets
private val BgRaised = Color(0xFF3D352C) // selected tab, chips, inputs
private val BorderColor = Color(0xFF5A5046) // borders and dividers
private val TextPrimary = Color(0xFFFBF8F4) // cream
private val TextSecondary = Color(0xFFCFC5B6)
private val AccentPrimary = Color(0xFFD98A68) // terracotta: buttons
private val OnAccent = Color(0xFF29241E) // text on terracotta
private val StatusSuccess = Color(0xFF2F6B3A)
private val StatusWarning = Color(0xFFB45309)
private val StatusDanger = Color(0xFFB4432F)

private val Palette = darkColorScheme(
    primary = AccentPrimary,
    onPrimary = OnAccent,
    primaryContainer = Color(0xFF4A3A30), // terracotta tint on brown
    onPrimaryContainer = TextPrimary,
    secondary = AccentPrimary,
    onSecondary = OnAccent,
    secondaryContainer = BgRaised,
    onSecondaryContainer = TextPrimary,
    background = BgMain,
    onBackground = TextPrimary,
    surface = BgMain,
    onSurface = TextPrimary,
    surfaceVariant = BgSurface,
    onSurfaceVariant = TextSecondary,
    surfaceContainerLowest = BgSurface,
    surfaceContainerLow = BgSurface,
    surfaceContainer = BgSurface,
    surfaceContainerHigh = BgRaised,
    surfaceContainerHighest = BgRaised,
    outline = BorderColor,
    outlineVariant = Color(0xFF4A4138),
    // Text in a problem colour uses a light tint that reads on brown; badges use the solid red.
    error = Color(0xFFF2A08F),
    onError = OnAccent,
    errorContainer = StatusDanger,
    onErrorContainer = Color.White,
)

// Fraunces for big headings, Instrument Sans for everything else (both SIL Open Font License).
private val Headline = FontFamily(Font(R.font.fraunces_regular, FontWeight.Normal), Font(R.font.fraunces_medium, FontWeight.Medium))
private val Body = FontFamily(
    Font(R.font.instrument_sans_regular, FontWeight.Normal),
    Font(R.font.instrument_sans_semibold, FontWeight.SemiBold),
    Font(R.font.instrument_sans_bold, FontWeight.Bold),
)
private val KioskTypography = Typography().let { t ->
    Typography(
        displayLarge = t.displayLarge.copy(fontFamily = Headline), displayMedium = t.displayMedium.copy(fontFamily = Headline),
        displaySmall = t.displaySmall.copy(fontFamily = Headline), headlineLarge = t.headlineLarge.copy(fontFamily = Headline),
        headlineMedium = t.headlineMedium.copy(fontFamily = Headline), headlineSmall = t.headlineSmall.copy(fontFamily = Headline),
        titleLarge = t.titleLarge.copy(fontFamily = Body), titleMedium = t.titleMedium.copy(fontFamily = Body),
        titleSmall = t.titleSmall.copy(fontFamily = Body), bodyLarge = t.bodyLarge.copy(fontFamily = Body),
        bodyMedium = t.bodyMedium.copy(fontFamily = Body), bodySmall = t.bodySmall.copy(fontFamily = Body),
        labelLarge = t.labelLarge.copy(fontFamily = Body), labelMedium = t.labelMedium.copy(fontFamily = Body),
        labelSmall = t.labelSmall.copy(fontFamily = Body),
    )
}

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
    attention = Color(0xFFE3A07F), attentionContainer = StatusWarning, onAttentionContainer = Color.White,
    // The "online" badge is solid green with white text and a white dot.
    success = Color.White, successContainer = StatusSuccess, onSuccessContainer = Color.White,
)

val LocalKioskColors = staticCompositionLocalOf { PaletteExtra }

@Composable
fun KioskTheme(content: @Composable () -> Unit) {
    androidx.compose.runtime.CompositionLocalProvider(LocalKioskColors provides PaletteExtra) {
        MaterialTheme(colorScheme = Palette, typography = KioskTypography, content = content)
    }
}
