// "Calm Slate" palette: dusty slate-blue primary, warm neutral greys, softened status colours.
// Mirrors server/public/styles.css. Light and dark mode.
package com.kiosk.admin.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

private val Light = lightColorScheme(
    primary = Color(0xFF35607A),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDCE6EC),
    onPrimaryContainer = Color(0xFF1E3A4A),
    secondary = Color(0xFF35607A),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFDCE6EC),
    onSecondaryContainer = Color(0xFF1E3A4A),
    background = Color(0xFFF6F5F2),
    onBackground = Color(0xFF1F2328),
    surface = Color(0xFFF6F5F2),
    onSurface = Color(0xFF1F2328),
    surfaceVariant = Color(0xFFECEAE5),
    onSurfaceVariant = Color(0xFF5A616B),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color.White,
    surfaceContainer = Color.White,
    surfaceContainerHigh = Color.White,
    surfaceContainerHighest = Color(0xFFECEAE5),
    outline = Color(0xFF8A9099),
    outlineVariant = Color(0xFFDAD8D2),
    error = Color(0xFFA23B3B),
    onError = Color.White,
    errorContainer = Color(0xFFF5E1DF),
    onErrorContainer = Color(0xFF5E1F1F),
)

private val Dark = darkColorScheme(
    primary = Color(0xFF8FB4C9),
    onPrimary = Color(0xFF12283A),
    primaryContainer = Color(0xFF2A4558),
    onPrimaryContainer = Color(0xFFD6E5EE),
    secondary = Color(0xFF8FB4C9),
    onSecondary = Color(0xFF12283A),
    secondaryContainer = Color(0xFF2A4558),
    onSecondaryContainer = Color(0xFFD6E5EE),
    background = Color(0xFF15181C),
    onBackground = Color(0xFFE6E8EB),
    surface = Color(0xFF15181C),
    onSurface = Color(0xFFE6E8EB),
    surfaceVariant = Color(0xFF252A30),
    onSurfaceVariant = Color(0xFFA7AEB7),
    surfaceContainerLowest = Color(0xFF1D2126),
    surfaceContainerLow = Color(0xFF1D2126),
    surfaceContainer = Color(0xFF1D2126),
    surfaceContainerHigh = Color(0xFF1D2126),
    surfaceContainerHighest = Color(0xFF252A30),
    outline = Color(0xFF6E7782),
    outlineVariant = Color(0xFF333940),
    error = Color(0xFFE39A94),
    onError = Color(0xFF3E1513),
    errorContainer = Color(0xFF4A1F1C),
    onErrorContainer = Color(0xFFF4D3CF),
)

/** Extra colours Material doesn't have: amber "attention" and sage "online". */
@Immutable
data class KioskColors(
    val attention: Color,
    val attentionContainer: Color,
    val onAttentionContainer: Color,
    val success: Color,
    val successContainer: Color,
    val onSuccessContainer: Color,
)

private val LightExtra = KioskColors(
    attention = Color(0xFFA0612A), attentionContainer = Color(0xFFF3E6D6), onAttentionContainer = Color(0xFF5A3712),
    success = Color(0xFF3F7A57), successContainer = Color(0xFFE0EDE4), onSuccessContainer = Color(0xFF234A33),
)
private val DarkExtra = KioskColors(
    attention = Color(0xFFD9A66E), attentionContainer = Color(0xFF3D2C1A), onAttentionContainer = Color(0xFFF0DCC3),
    success = Color(0xFF8CC3A0), successContainer = Color(0xFF1F3528), onSuccessContainer = Color(0xFFCDE6D5),
)

val LocalKioskColors = staticCompositionLocalOf { LightExtra }

@Composable
fun KioskTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    androidx.compose.runtime.CompositionLocalProvider(LocalKioskColors provides if (dark) DarkExtra else LightExtra) {
        MaterialTheme(colorScheme = if (dark) Dark else Light, content = content)
    }
}
