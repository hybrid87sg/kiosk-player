// Small building blocks shared by several screens.
package com.kiosk.admin.ui.common

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kiosk.core.model.ScreenShape
import java.util.Locale

/** Lets any screen show a short message at the bottom ("Saved", errors, ...). */
val LocalSnackbar = staticCompositionLocalOf { SnackbarHostState() }

/** Shows [message] once as a snackbar, then calls [onShown]. */
@Composable
fun ShowMessage(message: String?, onShown: () -> Unit) {
    val snackbar = LocalSnackbar.current
    LaunchedEffect(message) {
        if (message != null) {
            onShown()
            snackbar.showSnackbar(message)
        }
    }
}

/** A small outlined rectangle that shows landscape or portrait. */
@Composable
fun ShapeIcon(shape: ScreenShape, size: Dp, color: Color, modifier: Modifier = Modifier) {
    val long = size
    val short = size * 0.62f
    Box(
        modifier
            .size(if (shape == ScreenShape.PORTRAIT) short else long, if (shape == ScreenShape.PORTRAIT) long else short)
            .border(2.dp, color, RoundedCornerShape(3.dp))
            .clearAndSetSemantics { },
    )
}

/** A white rounded card with a thin outline, as used across the mockup. */
@Composable
fun KioskCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surfaceContainer,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(content = content)
    }
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(Locale.getDefault()),
        modifier = modifier.padding(horizontal = 4.dp),
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** The dashed "nothing here yet" box. */
@Composable
fun EmptyState(title: String, text: String) {
    Surface(
        Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surfaceContainer,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) {
        Column(Modifier.padding(horizontal = 24.dp, vertical = 32.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title, Modifier.fillMaxWidth(), style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
            Text(
                text, Modifier.fillMaxWidth(), style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
            )
        }
    }
}

/** 1400000000 -> "1.4 GB" */
fun formatBytes(bytes: Long): String = when {
    bytes >= 1_000_000_000 -> String.format(Locale.getDefault(), "%.1f GB", bytes / 1e9)
    bytes >= 1_000_000 -> String.format(Locale.getDefault(), "%.1f MB", bytes / 1e6)
    bytes >= 1_000 -> String.format(Locale.getDefault(), "%.0f KB", bytes / 1e3)
    else -> "$bytes B"
}

/** "3 h ago", "just now", ... for a time in milliseconds. */
fun timeAgo(millis: Long?, now: Long = System.currentTimeMillis()): String {
    if (millis == null) return "never"
    val minutes = (now - millis) / 60_000
    return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "$minutes min ago"
        minutes < 48 * 60 -> "${minutes / 60} h ago"
        else -> "${minutes / (24 * 60)} days ago"
    }
}
