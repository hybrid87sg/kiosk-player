// The colours from the mockup's style sheet, for light and dark mode.
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
    primary = Color(0xFF0F766E),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFCCFBF1),
    onPrimaryContainer = Color(0xFF0B4F4A),
    secondary = Color(0xFF0F766E),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFCCFBF1),
    onSecondaryContainer = Color(0xFF0B4F4A),
    background = Color(0xFFF4F8F7),
    onBackground = Color(0xFF10201E),
    surface = Color(0xFFF4F8F7),
    onSurface = Color(0xFF10201E),
    surfaceVariant = Color(0xFFEAF2F0),
    onSurfaceVariant = Color(0xFF4A5C59),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color.White,
    surfaceContainer = Color.White,
    surfaceContainerHigh = Color.White,
    surfaceContainerHighest = Color(0xFFEAF2F0),
    outline = Color(0xFF7A8C88),
    outlineVariant = Color(0xFFD3DEDB),
    error = Color(0xFFB91C1C),
    onError = Color.White,
    errorContainer = Color(0xFFFEE2E2),
    onErrorContainer = Color(0xFF7F1D1D),
)

private val Dark = darkColorScheme(
    primary = Color(0xFF5EEAD4),
    onPrimary = Color(0xFF042F2C),
    primaryContainer = Color(0xFF134E4A),
    onPrimaryContainer = Color(0xFFCCFBF1),
    secondary = Color(0xFF5EEAD4),
    onSecondary = Color(0xFF042F2C),
    secondaryContainer = Color(0xFF134E4A),
    onSecondaryContainer = Color(0xFFCCFBF1),
    background = Color(0xFF0E1716),
    onBackground = Color(0xFFE6F0EE),
    surface = Color(0xFF0E1716),
    onSurface = Color(0xFFE6F0EE),
    surfaceVariant = Color(0xFF1D2A28),
    onSurfaceVariant = Color(0xFFA3B5B1),
    surfaceContainerLowest = Color(0xFF16211F),
    surfaceContainerLow = Color(0xFF16211F),
    surfaceContainer = Color(0xFF16211F),
    surfaceContainerHigh = Color(0xFF16211F),
    surfaceContainerHighest = Color(0xFF1D2A28),
    outline = Color(0xFF6B8580),
    outlineVariant = Color(0xFF2C3B38),
    error = Color(0xFFFCA5A5),
    onError = Color(0xFF450A0A),
    errorContainer = Color(0xFF450A0A),
    onErrorContainer = Color(0xFFFECACA),
)

/** Extra colours Material doesn't have: orange "attention" and green "online". */
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
    attention = Color(0xFFC2410C), attentionContainer = Color(0xFFFFEDD5), onAttentionContainer = Color(0xFF7C2D12),
    success = Color(0xFF15803D), successContainer = Color(0xFFDCFCE7), onSuccessContainer = Color(0xFF14532D),
)
private val DarkExtra = KioskColors(
    attention = Color(0xFFFDBA74), attentionContainer = Color(0xFF431407), onAttentionContainer = Color(0xFFFED7AA),
    success = Color(0xFF86EFAC), successContainer = Color(0xFF14361F), onSuccessContainer = Color(0xFFBBF7D0),
)

val LocalKioskColors = staticCompositionLocalOf { LightExtra }

@Composable
fun KioskTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    androidx.compose.runtime.CompositionLocalProvider(LocalKioskColors provides if (dark) DarkExtra else LightExtra) {
        MaterialTheme(colorScheme = if (dark) Dark else Light, content = content)
    }
}
